/**
 * F1 识别流程 + F3 批量确认页：
 * 压缩 → 识别 → ResponseParser → F2 → 草稿持久化 → 人工确认/编辑 → 单题独立事务入库。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QuestionAnswer, QuestionDraft, ReviewStatus } from '../core/models';
import { f2ValidatePage, f2ValidateQuestion } from '../core/validation/f2';
import { normalizeAnswer, normalizeOptions } from '../core/validation/normalize';
import { DEFAULT_BANK_ID } from '../db/database';
import { indexQuestion } from '../db/fts';
import { createBatch, createPage, saveDraftItems, setItemStatus, updateItemDraft, updatePageStatus } from '../db/repo_imports';
import { insertQuestion } from '../db/repo_questions';
import { RECOGNITION_PROMPT } from '../prompts/recognition';
import { prepareImageForRecognition } from '../services/image';
import type { LLMService } from '../services/llm/LLMService';
import { getModelTier, modelIdForTier } from '../services/modelPrefs';
import { parseModelText } from '../services/llm/ResponseParser';
import { ZhipuVisionEngine } from '../services/recognition/zhipuVision';

type Phase = 'recognizing' | 'reviewing' | 'inserting' | 'done' | 'error';

interface ReviewItem {
  itemId: string;
  draft: QuestionDraft;
  status: ReviewStatus;
  issues: string[];
  selected: boolean;
  answerText: string;
}

export interface ReviewScreenProps {
  db: SQLiteDatabase;
  llm: LLMService;
  imagePath: string;
  imageWidth?: number;
  imageHeight?: number;
  sourceType: 'photo' | 'gallery';
  onDone: () => void;
}

function answerToText(a: QuestionAnswer): string {
  if (a === null || a === undefined) return '';
  if (typeof a === 'boolean') return a ? '对' : '错';
  if (Array.isArray(a)) return a.join(',');
  return String(a);
}

function statusLabel(s: ReviewStatus): string {
  return s === 'passed' ? '可入库' : s === 'needs_review' ? '需复核' : '无效';
}

function statusColor(s: ReviewStatus): string {
  return s === 'passed' ? '#0a7d33' : s === 'needs_review' ? '#b8860b' : '#c02a2a';
}

function typeLabel(t: string): string {
  return t === 'single' ? '单选' : t === 'multiple' ? '多选' : t === 'judge' ? '判断' : t;
}

export function ReviewScreen({ db, llm, imagePath, imageWidth, imageHeight, sourceType, onDone }: ReviewScreenProps) {
  const [phase, setPhase] = useState<Phase>('recognizing');
  const [progressText, setProgressText] = useState('正在压缩图片…');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [imageUri, setImageUri] = useState(imagePath);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<string | null>(null);
  const [insertResult, setInsertResult] = useState<{ ok: number; failed: string[] } | null>(null);
  const [showImage, setShowImage] = useState(false);
  const itemsRef = useRef<ReviewItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const runRecognition = useCallback(async () => {
    setPhase('recognizing');
    setError(null);
    setProgressText('正在压缩图片…');
    try {
      const prepared = await prepareImageForRecognition(imagePath, imageWidth, imageHeight);
      setImageUri(prepared.uri);
      const batchId = await createBatch(db, sourceType);
      const pageId = await createPage(db, batchId, prepared.uri, 1);
      await updatePageStatus(db, pageId, 'processing', null, true);

      setProgressText('正在识别（大模型推理中，约 10-60 秒）…');
      const tier = await getModelTier();
      const engine = new ZhipuVisionEngine(llm, modelIdForTier(tier));
      const out = await engine.recognize({ imageBase64: prepared.base64, prompt: RECOGNITION_PROMPT });
      if (!out.ok || !out.raw) {
        await updatePageStatus(db, pageId, 'failed', out.error?.code ?? 'unknown');
        setError(out.error?.userMessage ?? '识别请求失败');
        setPhase('error');
        return;
      }
      const parsed = parseModelText(out.raw);
      if (!parsed.drafts) {
        await updatePageStatus(db, pageId, 'failed', 'parse');
        setError('模型输出无法解析：' + (parsed.error ?? '未知原因'));
        setPhase('error');
        return;
      }
      if (parsed.drafts.length === 0) {
        await updatePageStatus(db, pageId, 'recognized');
        setError('本页未识别到题目。可以重试，或换一张更清晰、更完整的图片。');
        setPhase('error');
        return;
      }
      const f2 = f2ValidatePage(parsed.drafts);
      const drafts: QuestionDraft[] = parsed.drafts.map((d, i) => {
        const base = (d && typeof d === 'object' && !Array.isArray(d) ? d : {}) as Record<string, unknown>;
        const r = f2[i];
        const rawOptions = Array.isArray(base.options) ? base.options : [];
        return {
          type: (base.type === 'multiple' ? 'multiple' : base.type === 'judge' ? 'judge' : 'single') as QuestionDraft['type'],
          stem: typeof base.stem === 'string' ? base.stem : '',
          options: normalizeOptions(rawOptions).options,
          answer: (base.answer ?? null) as QuestionAnswer,
          analysis: null,
          tags: [],
          confidence: typeof base.confidence === 'number' ? base.confidence : null,
          review_reasons: r.issues.map((x) => x.message),
          visual_features: Array.isArray(base.visual_features) ? base.visual_features.map(String) : [],
          source_image_path: prepared.uri,
          source_page: 1,
          source_engine: 'zhipu',
          status: 'pending',
          review_status: r.status,
        } as QuestionDraft;
      });
      const ids = await saveDraftItems(db, batchId, pageId, drafts, 'draft', out.raw);
      await updatePageStatus(db, pageId, 'needs_review');
      setItems(
        drafts.map((d, i) => ({
          itemId: ids[i],
          draft: d,
          status: f2[i].status,
          issues: f2[i].issues.map((x) => x.message),
          selected: f2[i].status !== 'invalid',
          answerText: answerToText(d.answer),
        })),
      );
      setStats(`耗时 ${(out.latencyMs / 1000).toFixed(1)}s · 尝试 ${out.attempts} 次 · 解析 ${parsed.mode}`);
      setPhase('reviewing');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('error');
    }
  }, [db, llm, imagePath, imageWidth, imageHeight, sourceType]);

  useEffect(() => {
    void runRecognition();
  }, [runRecognition]);

  const patchItem = useCallback((id: string, patch: Partial<ReviewItem>) => {
    setItems((prev) => prev.map((x) => (x.itemId === id ? { ...x, ...patch } : x)));
  }, []);

  const patchOptionText = useCallback((id: string, optIndex: number, text: string) => {
    setItems((prev) =>
      prev.map((x) => {
        if (x.itemId !== id) return x;
        const options = x.draft.options.map((o, i) => (i === optIndex ? { ...o, text } : o));
        return { ...x, draft: { ...x.draft, options } };
      }),
    );
  }, []);

  const revalidate = useCallback(
    async (id: string) => {
      const it = itemsRef.current.find((x) => x.itemId === id);
      if (!it) return;
      const ids = it.draft.options.map((o) => o.id).filter(Boolean);
      const answer = normalizeAnswer(it.draft.type, it.answerText, ids).answer;
      const draft: QuestionDraft = { ...it.draft, answer };
      const r = f2ValidateQuestion(draft, { normalize: false });
      const updated: QuestionDraft = { ...draft, review_status: r.status, review_reasons: r.issues.map((x) => x.message) };
      const issues = r.issues.map((x) => x.message);
      setItems((prev) =>
        prev.map((x) =>
          x.itemId === id
            ? { ...x, draft: updated, status: r.status, issues, selected: r.status === 'invalid' ? false : x.selected }
            : x,
        ),
      );
      try {
        await updateItemDraft(db, id, updated);
      } catch {
        /* 落库失败不阻塞界面 */
      }
    },
    [db],
  );

  const insertSelected = useCallback(async () => {
    const targets = itemsRef.current.filter((x) => x.selected);
    if (targets.length === 0) {
      Alert.alert('请先勾选要入库的题目');
      return;
    }
    setPhase('inserting');
    let ok = 0;
    const failed: string[] = [];
    for (const it of targets) {
      try {
        await db.withTransactionAsync(async () => {
          const qid = await insertQuestion(db, DEFAULT_BANK_ID, { ...it.draft, review_status: it.status });
          await indexQuestion(db, qid, it.draft.stem);
          await setItemStatus(db, it.itemId, 'inserted');
        });
        ok += 1;
      } catch (e) {
        failed.push(`${it.draft.stem.slice(0, 12)}…：${(e as Error)?.message ?? e}`);
        try {
          await setItemStatus(db, it.itemId, 'needs_review');
        } catch {
          /* ignore */
        }
      }
    }
    setInsertResult({ ok, failed });
    setPhase('done');
  }, [db]);

  const toggleAll = useCallback((selected: boolean) => {
    setItems((prev) => prev.map((x) => (x.status === 'invalid' ? x : { ...x, selected })));
  }, []);

  // ---------------------------------------------------------------- 渲染
  if (phase === 'recognizing') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.centerText}>{progressText}</Text>
        <Text style={styles.centerHint}>识别失败不会丢失照片，可以随时重试。</Text>
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>识别未完成</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.primaryBtn} onPress={() => void runRecognition()}>
          <Text style={styles.primaryBtnText}>重试识别</Text>
        </Pressable>
        <Pressable style={styles.ghostBtn} onPress={onDone}>
          <Text style={styles.ghostBtnText}>返回首页</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'inserting') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.centerText}>正在入库…</Text>
      </View>
    );
  }

  if (phase === 'done') {
    return (
      <View style={styles.center}>
        <Text style={styles.doneTitle}>入库完成</Text>
        <Text style={styles.centerText}>成功 {insertResult?.ok ?? 0} 题</Text>
        {(insertResult?.failed.length ?? 0) > 0 && (
          <Text style={styles.errorText}>失败 {insertResult?.failed.length} 题：{insertResult?.failed.join('\n')}</Text>
        )}
        <Pressable style={styles.primaryBtn} onPress={onDone}>
          <Text style={styles.primaryBtnText}>返回首页</Text>
        </Pressable>
      </View>
    );
  }

  const passed = items.filter((x) => x.status === 'passed').length;
  const review = items.filter((x) => x.status === 'needs_review').length;
  const invalid = items.filter((x) => x.status === 'invalid').length;
  const selectedCount = items.filter((x) => x.selected).length;

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={onDone} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>确认入库</Text>
        <Pressable onPress={() => setShowImage(true)} hitSlop={8}>
          <Text style={styles.back}>看原图</Text>
        </Pressable>
      </View>
      <Text style={styles.summary}>
        共 {items.length} 题 · 可入库 {passed} · 需复核 {review} · 无效 {invalid} · 已选 {selectedCount}
        {stats ? `　（${stats}）` : ''}
      </Text>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {items.map((it, idx) => (
          <View key={it.itemId} style={[styles.card, !it.selected && styles.cardUnselected]}>
            <View style={styles.cardHeader}>
              <Pressable
                onPress={() => patchItem(it.itemId, { selected: !it.selected })}
                style={[styles.checkbox, it.selected && styles.checkboxOn]}
                hitSlop={6}
              >
                {it.selected && <Text style={styles.checkboxMark}>✓</Text>}
              </Pressable>
              <Text style={styles.cardIndex}>第 {idx + 1} 题</Text>
              <View style={[styles.badge, { backgroundColor: statusColor(it.status) }]}>
                <Text style={styles.badgeText}>{statusLabel(it.status)}</Text>
              </View>
              <Text style={styles.typeText}>{typeLabel(it.draft.type)}</Text>
            </View>
            <TextInput
              style={styles.stemInput}
              value={it.draft.stem}
              multiline
              onChangeText={(t) => patchItem(it.itemId, { draft: { ...it.draft, stem: t } })}
            />
            {it.draft.options.map((o, oi) => (
              <View key={`${o.id}-${oi}`} style={styles.optRow}>
                <Text style={styles.optId}>{o.id || '?'}</Text>
                <TextInput
                  style={styles.optInput}
                  value={o.text}
                  onChangeText={(t) => patchOptionText(it.itemId, oi, t)}
                />
              </View>
            ))}
            <View style={styles.answerRow}>
              <Text style={styles.answerLabel}>答案</Text>
              <TextInput
                style={styles.answerInput}
                value={it.answerText}
                placeholder="空 / 对 / 错 / A / A,C"
                onChangeText={(t) => patchItem(it.itemId, { answerText: t })}
              />
              <Pressable style={styles.revalidateBtn} onPress={() => void revalidate(it.itemId)}>
                <Text style={styles.revalidateText}>重新校验</Text>
              </Pressable>
            </View>
            {it.issues.length > 0 && <Text style={styles.issues}>{it.issues.join('\n')}</Text>}
          </View>
        ))}
        <View style={{ height: 24 }} />
      </ScrollView>

      <View style={styles.footerBar}>
        <Pressable style={styles.smallGhost} onPress={() => toggleAll(true)}>
          <Text style={styles.smallGhostText}>全选</Text>
        </Pressable>
        <Pressable style={styles.smallGhost} onPress={() => toggleAll(false)}>
          <Text style={styles.smallGhostText}>全不选</Text>
        </Pressable>
        <Pressable style={styles.primaryBtnSmall} onPress={() => void insertSelected()}>
          <Text style={styles.primaryBtnText}>入库所选（{selectedCount}）</Text>
        </Pressable>
      </View>

      <Modal visible={showImage} transparent onRequestClose={() => setShowImage(false)}>
        <View style={styles.modalBg}>
          <Image source={{ uri: imageUri }} style={styles.modalImage} resizeMode="contain" />
          <Pressable style={styles.modalClose} onPress={() => setShowImage(false)}>
            <Text style={styles.modalCloseText}>关闭</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 56 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f7f8fa', paddingHorizontal: 28 },
  centerText: { marginTop: 16, fontSize: 16, color: '#333' },
  centerHint: { marginTop: 10, fontSize: 12, color: '#8a94a6' },
  errorTitle: { fontSize: 18, fontWeight: '700', color: '#c02a2a' },
  errorText: { marginTop: 12, fontSize: 14, color: '#444', lineHeight: 21, textAlign: 'center' },
  doneTitle: { fontSize: 22, fontWeight: '800', color: '#0a7d33' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  back: { fontSize: 15, color: '#1c5cd6' },
  title: { fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  summary: { paddingHorizontal: 16, marginTop: 8, fontSize: 12, color: '#66707f' },
  list: { flex: 1, marginTop: 8 },
  listContent: { paddingHorizontal: 12 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10 },
  cardUnselected: { opacity: 0.55 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: '#9aa7bd', alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: '#1c5cd6', borderColor: '#1c5cd6' },
  checkboxMark: { color: '#fff', fontSize: 14, fontWeight: '800' },
  cardIndex: { fontSize: 13, fontWeight: '700', color: '#333' },
  badge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  typeText: { marginLeft: 'auto', fontSize: 12, color: '#8a94a6' },
  stemInput: { marginTop: 10, fontSize: 14, color: '#222', lineHeight: 20, borderBottomWidth: 1, borderBottomColor: '#eef1f6', paddingBottom: 6 },
  optRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  optId: { width: 22, fontSize: 14, fontWeight: '700', color: '#31518a' },
  optInput: { flex: 1, fontSize: 14, color: '#333', borderBottomWidth: 1, borderBottomColor: '#eef1f6', paddingVertical: 2 },
  answerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 },
  answerLabel: { fontSize: 13, color: '#66707f' },
  answerInput: { flex: 1, fontSize: 14, color: '#222', backgroundColor: '#f2f5fa', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  revalidateBtn: { backgroundColor: '#e8f0ff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  revalidateText: { color: '#1c5cd6', fontSize: 12, fontWeight: '700' },
  issues: { marginTop: 10, fontSize: 12, color: '#b8860b', lineHeight: 18 },
  footerBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 24, paddingTop: 8, backgroundColor: '#f7f8fa' },
  smallGhost: { borderRadius: 10, borderWidth: 1, borderColor: '#cfd9ea', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#fff' },
  smallGhostText: { color: '#31518a', fontSize: 13 },
  primaryBtn: { marginTop: 24, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 40 },
  primaryBtnSmall: { flex: 1, backgroundColor: '#1c5cd6', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  ghostBtn: { marginTop: 12, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 40, borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff' },
  ghostBtnText: { color: '#31518a', fontSize: 14 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  modalImage: { width: '100%', height: '85%' },
  modalClose: { marginTop: 16, paddingVertical: 10, paddingHorizontal: 32, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)' },
  modalCloseText: { color: '#fff', fontSize: 15 },
});
