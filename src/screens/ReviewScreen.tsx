/**
 * F1 识别流程 + F3 批量确认页（M1-C/M1-D）：
 * 压缩 → 识别（整页未成功自动切半兜底；可手动框选重识别）→ ResponseParser → F2
 * → 草稿持久化 → 人工确认/编辑 → 单题独立事务入库（题干查重防重复入库）。
 * 支持从持久化草稿恢复（应用被杀后重启不丢进度、不重复入库）。
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
import { CropModal } from '../components/CropModal';
import type { QuestionAnswer, QuestionDraft, ReviewStatus } from '../core/models';
import { normalizeStem } from '../core/dedupe';
import { f2ValidatePage, f2ValidateQuestion } from '../core/validation/f2';
import { normalizeAnswer, normalizeOptions } from '../core/validation/normalize';
import { DEFAULT_BANK_ID } from '../db/database';
import { indexQuestion } from '../db/fts';
import {
  createBatch,
  createPage,
  deleteDraftItemsByPage,
  getItemsByBatch,
  getPagesByBatch,
  rowToDraft,
  saveDraftItems,
  setItemStatus,
  updateItemDraft,
  updatePageStatus,
} from '../db/repo_imports';
import { insertQuestion } from '../db/repo_questions';
import { RECOGNITION_PROMPT } from '../prompts/recognition';
import { cropImage, makeHalves, prepareImageForRecognition, type CropRect, type PreparedImage } from '../services/image';
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
  /** 草稿生命周期状态：pending=可编辑待处理；inserted/discarded=只读历史 */
  state: 'pending' | 'inserted' | 'discarded';
}

export interface ReviewScreenProps {
  db: SQLiteDatabase;
  llm: LLMService;
  onDone: () => void;
  /** 新识别模式 */
  imagePath?: string;
  imageWidth?: number;
  imageHeight?: number;
  sourceType?: 'photo' | 'gallery';
  /** 恢复模式（传入未完成批次 ID） */
  resumeBatchId?: string;
}

type RecognizeOutcome =
  | { ok: true; drafts: unknown[]; mode: string; latencyMs: number; attempts: number }
  | { ok: false; message: string; code: string | null };

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

export function ReviewScreen({
  db,
  llm,
  onDone,
  imagePath,
  imageWidth,
  imageHeight,
  sourceType,
  resumeBatchId,
}: ReviewScreenProps) {
  const [phase, setPhase] = useState<Phase>('recognizing');
  const [progressText, setProgressText] = useState('正在压缩图片…');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [imageUri, setImageUri] = useState(imagePath ?? '');
  const [imageDims, setImageDims] = useState<{ w: number; h: number }>({
    w: imageWidth ?? 0,
    h: imageHeight ?? 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<string | null>(null);
  const [insertResult, setInsertResult] = useState<{ ok: number; dup: number; skipped: number; failed: string[] } | null>(null);
  const [showImage, setShowImage] = useState(false);
  const [showCrop, setShowCrop] = useState(false);
  const [cropPurpose, setCropPurpose] = useState<'recognize' | 'figure'>('recognize');
  const [figureTargetId, setFigureTargetId] = useState<string | null>(null);
  const [showFigureUri, setShowFigureUri] = useState<string | null>(null);

  const itemsRef = useRef<ReviewItem[]>([]);
  const batchRef = useRef<string | null>(null);
  const pageRef = useRef<string | null>(null);
  const preparedRef = useRef<PreparedImage | null>(null);
  const startedRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const yMapRef = useRef<Record<string, number>>({});
  const jumpRef = useRef(0);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const recognizeOnce = useCallback(
    async (engine: ZhipuVisionEngine, b64: string): Promise<RecognizeOutcome> => {
      const out = await engine.recognize({ imageBase64: b64, prompt: RECOGNITION_PROMPT });
      if (!out.ok || !out.raw) {
        return { ok: false, message: out.error?.userMessage ?? '识别请求失败', code: out.error?.code ?? null };
      }
      const parsed = parseModelText(out.raw);
      if (!parsed.drafts) {
        return { ok: false, message: '模型输出无法解析：' + (parsed.error ?? '未知原因'), code: 'parse' };
      }
      return { ok: true, drafts: parsed.drafts, mode: parsed.mode, latencyMs: out.latencyMs, attempts: out.attempts };
    },
    [],
  );

  const applyDrafts = useCallback(
    async (drafts: unknown[], progressLabel: string, merge = false) => {
      // 补识别场景（merge）：过滤掉与当前列表题干重复的新草稿，只追加新题
      let incoming = drafts;
      if (merge) {
        const existing = new Set(itemsRef.current.map((x) => normalizeStem(x.draft.stem)));
        incoming = drafts.filter((d) => {
          const stem =
            d && typeof d === 'object' && typeof (d as Record<string, unknown>).stem === 'string'
              ? String((d as Record<string, unknown>).stem)
              : '';
          return !existing.has(normalizeStem(stem));
        });
        if (incoming.length === 0) {
          setStats(progressLabel + ' · 未发现新题目');
          setPhase('reviewing');
          return;
        }
      }
      const f2 = f2ValidatePage(incoming);
      const questionDrafts: QuestionDraft[] = incoming.map((d, i) => {
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
          source_image_path: preparedRef.current?.uri ?? imageUri,
          source_page: 1,
          source_engine: 'zhipu',
          status: 'pending',
          review_status: r.status,
        } as QuestionDraft;
      });
      if (!merge && pageRef.current) {
        await deleteDraftItemsByPage(db, pageRef.current);
      }
      const ids = await saveDraftItems(db, batchRef.current ?? '', pageRef.current ?? '', questionDrafts, 'draft', null);
      if (pageRef.current) {
        await updatePageStatus(db, pageRef.current, 'needs_review');
      }
      const newItems = questionDrafts.map((d, i) => ({
          itemId: ids[i],
          draft: d,
          status: f2[i].status,
          issues: f2[i].issues.map((x) => x.message),
          selected: f2[i].status !== 'invalid',
          answerText: answerToText(d.answer),
          state: 'pending' as const,
        }));
      setItems((prev) => (merge ? [...prev, ...newItems] : newItems));
      setStats(progressLabel);
      setPhase('reviewing');
    },
    [db, imageUri],
  );

  const runRecognition = useCallback(
    async (opts?: { crop?: CropRect; forceHalves?: boolean; merge?: boolean }) => {
      setPhase('recognizing');
      setError(null);
      setProgressText(opts?.crop ? '正在裁切选区…' : '正在压缩图片…');
      try {
        if (!imagePath) {
          setError('缺少图片来源');
          setPhase('error');
          return;
        }
        let prep = preparedRef.current;
        if (!prep) {
          prep = await prepareImageForRecognition(imagePath, imageWidth, imageHeight);
          preparedRef.current = prep;
          setImageUri(prep.uri);
          setImageDims({ w: prep.width, h: prep.height });
        }
        if (!batchRef.current) {
          batchRef.current = await createBatch(db, sourceType ?? 'photo');
          pageRef.current = await createPage(db, batchRef.current, prep.uri, 1);
        }
        if (pageRef.current) {
          await updatePageStatus(db, pageRef.current, 'processing', null, true);
        }
        const tier = await getModelTier();
        const engine = new ZhipuVisionEngine(llm, modelIdForTier(tier));

        const finish = async (outcome: RecognizeOutcome, label: string) => {
          if (!outcome.ok) {
            if (pageRef.current) {
              await updatePageStatus(db, pageRef.current, 'failed', outcome.code ?? 'unknown');
            }
            setError(outcome.message);
            setPhase('error');
            return;
          }
          if (outcome.drafts.length === 0) {
            if (pageRef.current) {
              await updatePageStatus(db, pageRef.current, 'recognized');
            }
            setError('本页未识别到题目。可以重试、手动框选局部区域，或换一张更清晰完整的图片。');
            setPhase('error');
            return;
          }
          await applyDrafts(outcome.drafts, label, opts?.merge);
        };

        // 模式 1：用户手动框选 → 只识别选区
        if (opts?.crop) {
          setProgressText('正在识别选区…');
          const cropped = await cropImage(prep.uri, opts.crop);
          const r = await recognizeOnce(engine, cropped.base64);
          if (r.ok) {
            await finish(r, `选区识别 · 耗时 ${(r.latencyMs / 1000).toFixed(1)}s · 解析 ${r.mode}`);
          } else {
            await finish(r, '');
          }
          return;
        }

        // 模式 2：整页识别，失败/空则自动切半兜底（也可由用户手动触发切半补识别）
        let firstIssue = '用户手动触发切半';
        let wholeLatency = 0;
        if (!opts?.forceHalves) {
          setProgressText('正在识别（大模型推理中，约 10-60 秒）…');
          const whole = await recognizeOnce(engine, prep.base64);
          if (whole.ok && whole.drafts.length > 0) {
            await finish(whole, `整页识别 · 耗时 ${(whole.latencyMs / 1000).toFixed(1)}s · 解析 ${whole.mode}`);
            return;
          }
          firstIssue = whole.ok ? '整页未提取到题目' : whole.message;
          if (whole.ok) wholeLatency = whole.latencyMs;
          setProgressText('整页识别未成功，正在尝试上下半页…');
        } else {
          setProgressText('正在识别上下半页…');
        }
        const halves = await makeHalves(prep);
        const merged: unknown[] = [];
        let mergedLatency = 0;
        let halfFailReason: string | null = null;
        for (const half of halves) {
          const r = await recognizeOnce(engine, half.base64);
          if (r.ok) {
            merged.push(...r.drafts);
            mergedLatency += r.latencyMs;
          } else {
            halfFailReason = r.message;
          }
        }
        if (merged.length > 0) {
          await finish(
            { ok: true, drafts: merged, mode: 'halves', latencyMs: wholeLatency + mergedLatency, attempts: 2 },
            `上下半页合并 · 耗时 ${((mergedLatency + wholeLatency) / 1000).toFixed(1)}s（${firstIssue}）`,
          );
          return;
        }
        await finish(
          {
            ok: false,
            message: `本页识别未成功（整页：${firstIssue}${halfFailReason ? '；切半：' + halfFailReason : ''}）。可手动框选局部区域再试。`,
            code: 'all_failed',
          },
          '',
        );
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        setPhase('error');
      }
    },
    [db, llm, imagePath, imageWidth, imageHeight, sourceType, recognizeOnce, applyDrafts],
  );

  const loadExisting = useCallback(
    async (batchId: string) => {
      try {
        const rows = await getItemsByBatch(db, batchId);
        const pages = await getPagesByBatch(db, batchId);
        const restored: ReviewItem[] = rows.map((r) => {
            const d = rowToDraft(r);
            const status = (d.review_status ?? 'needs_review') as ReviewStatus;
            const state =
              r.status === 'inserted' ? ('inserted' as const) : r.status === 'discarded' ? ('discarded' as const) : ('pending' as const);
            return {
              itemId: r.id,
              draft: d,
              status,
              issues: d.review_reasons ?? [],
              selected: state === 'pending' && status !== 'invalid',
              answerText: answerToText(d.answer),
              state,
            };
          });
        batchRef.current = batchId;
        pageRef.current = pages[0]?.id ?? null;
        if (pages[0]?.image_path) {
          setImageUri(pages[0].image_path);
        }
        if (restored.length === 0) {
          setError('该批次没有任何题目草稿。');
          setPhase('error');
          return;
        }
        setItems(restored);
        setStats('历史导入记录');
        setPhase('reviewing');
      } catch (e) {
        setError('恢复草稿失败：' + String((e as Error)?.message ?? e));
        setPhase('error');
      }
    },
    [db],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (resumeBatchId) {
      void loadExisting(resumeBatchId);
    } else {
      void runRecognition();
    }
  }, [resumeBatchId, loadExisting, runRecognition]);

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
    let dup = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const it of targets) {
      // 未通过校验（红标）或空题干的题目不得入库（§F3：不能被普通确认操作绕过）
      if (it.status === 'invalid' || !it.draft.stem.trim()) {
        skipped += 1;
        continue;
      }
      try {
        // 防重复入库：库中已存在相同题干（非停用）则跳过
        const existing = await db.getFirstAsync<{ id: string }>(
          "SELECT id FROM questions WHERE bank_id = ? AND stem = ? AND status != 'disabled' LIMIT 1",
          DEFAULT_BANK_ID,
          it.draft.stem,
        );
        if (existing) {
          dup += 1;
          await setItemStatus(db, it.itemId, 'discarded');
          continue;
        }
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
    setInsertResult({ ok, dup, skipped, failed });
    setPhase('done');
  }, [db]);

  const toggleAll = useCallback((selected: boolean) => {
    setItems((prev) => prev.map((x) => (x.state !== 'pending' || x.status === 'invalid' ? x : { ...x, selected })));
  }, []);

  /** 编辑失焦时落库（§3.3：每次编辑及时写入 import_items，不依赖内存状态） */
  const saveItemDraft = useCallback(
    async (id: string) => {
      const it = itemsRef.current.find((x) => x.itemId === id);
      if (!it) return;
      try {
        await updateItemDraft(db, id, it.draft);
      } catch {
        /* 落库失败不阻塞界面 */
      }
    },
    [db],
  );

  const jumpToNextInvalid = useCallback(() => {
    const invalids = itemsRef.current.filter((x) => x.status === 'invalid');
    if (invalids.length === 0) return;
    const target = invalids[jumpRef.current % invalids.length];
    jumpRef.current += 1;
    const y = yMapRef.current[target.itemId];
    if (y !== undefined) {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
    }
  }, []);

  /** 为某道题截取配图（图形类题干/选项无法用文字表达时使用） */
  const attachFigure = useCallback(
    async (itemId: string, rect: CropRect) => {
      const prep = preparedRef.current;
      if (!prep) return;
      try {
        const cropped = await cropImage(prep.uri, rect);
        const it = itemsRef.current.find((x) => x.itemId === itemId);
        if (!it) return;
        const updated: QuestionDraft = { ...it.draft, question_image_path: cropped.uri };
        setItems((prev) => prev.map((x) => (x.itemId === itemId ? { ...x, draft: updated } : x)));
        await updateItemDraft(db, itemId, updated);
      } catch (e) {
        Alert.alert('配图失败', String((e as Error)?.message ?? e));
      }
    },
    [db],
  );

  const removeFigure = useCallback(
    async (itemId: string) => {
      const it = itemsRef.current.find((x) => x.itemId === itemId);
      if (!it) return;
      const updated: QuestionDraft = { ...it.draft, question_image_path: null };
      setItems((prev) => prev.map((x) => (x.itemId === itemId ? { ...x, draft: updated } : x)));
      try {
        await updateItemDraft(db, itemId, updated);
      } catch {
        /* ignore */
      }
    },
    [db],
  );

  // ---------------------------------------------------------------- 渲染
  if (phase === 'recognizing') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.centerText}>{progressText}</Text>
        <Text style={styles.centerHint}>识别失败不会丢失照片，可以随时重试或框选局部区域。</Text>
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>识别未完成</Text>
        <Text style={styles.errorText}>{error}</Text>
        {!resumeBatchId && (
          <>
            <Pressable style={styles.primaryBtn} onPress={() => void runRecognition()}>
              <Text style={styles.primaryBtnText}>重试识别</Text>
            </Pressable>
            <Pressable style={styles.ghostBtn} onPress={() => setShowCrop(true)}>
              <Text style={styles.ghostBtnText}>手动框选局部区域</Text>
            </Pressable>
          </>
        )}
        <Pressable style={styles.ghostBtn} onPress={onDone}>
          <Text style={styles.ghostBtnText}>返回首页</Text>
        </Pressable>
        <CropModalHost
          visible={showCrop}
          imageUri={imageUri}
          imageWidth={imageDims.w}
          imageHeight={imageDims.h}
          onCancel={() => setShowCrop(false)}
          onConfirm={(rect) => {
            setShowCrop(false);
            void runRecognition({ crop: rect });
          }}
        />
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
        {(insertResult?.dup ?? 0) > 0 && (
          <Text style={styles.centerHint}>跳过 {insertResult?.dup} 题（题库中已存在相同题干）</Text>
        )}
        {(insertResult?.skipped ?? 0) > 0 && (
          <Text style={styles.centerHint}>
            跳过 {insertResult?.skipped} 题（未通过校验或题干为空，请先修正为「可入库/需复核」再入库）
          </Text>
        )}
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
  const insertedCount = items.filter((x) => x.state === 'inserted').length;

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
      <View style={styles.summaryRow}>
        <Text style={styles.summary}>
          共 {items.length} 题{insertedCount > 0 ? ` · 已入库 ${insertedCount}` : ''} · 可入库 {passed} · 需复核 {review} ·
          无效 {invalid} · 已选 {selectedCount}
        </Text>
        {invalid > 0 && (
          <Pressable onPress={jumpToNextInvalid} style={styles.jumpBtn} hitSlop={6}>
            <Text style={styles.jumpBtnText}>跳到无效题</Text>
          </Pressable>
        )}
      </View>
      {stats ? <Text style={styles.summarySub}>{stats}</Text> : null}

      <ScrollView ref={scrollRef} style={styles.list} contentContainerStyle={styles.listContent}>
        {items.map((it, idx) => (
          it.state !== 'pending' ? (
            <View key={it.itemId} style={[styles.card, styles.cardLocked]}>
              <View style={styles.cardHeader}>
                <View style={[styles.badge, { backgroundColor: it.state === 'inserted' ? '#0a7d33' : '#8a94a6' }]}>
                  <Text style={styles.badgeText}>{it.state === 'inserted' ? '已入库' : '已丢弃'}</Text>
                </View>
                <Text style={styles.cardIndex}>第 {idx + 1} 题</Text>
                <Text style={styles.typeText}>{typeLabel(it.draft.type)}</Text>
              </View>
              <Text style={styles.readonlyStem}>{it.draft.stem}</Text>
            </View>
          ) : (
          <View
            key={it.itemId}
            onLayout={(e) => {
              yMapRef.current[it.itemId] = e.nativeEvent.layout.y;
            }}
            style={[styles.card, !it.selected && styles.cardUnselected]}
          >
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
              onBlur={() => void saveItemDraft(it.itemId)}
            />
            {it.draft.options.map((o, oi) => (
              <View key={`${o.id}-${oi}`} style={styles.optRow}>
                <Text style={styles.optId}>{o.id || '?'}</Text>
                <TextInput
                  style={styles.optInput}
                  value={o.text}
                  onChangeText={(t) => patchOptionText(it.itemId, oi, t)}
                  onBlur={() => void saveItemDraft(it.itemId)}
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
                onBlur={() => void saveItemDraft(it.itemId)}
              />
              <Pressable style={styles.revalidateBtn} onPress={() => void revalidate(it.itemId)}>
                <Text style={styles.revalidateText}>重新校验</Text>
              </Pressable>
            </View>
            <View style={styles.figureRow}>
              <Text style={styles.answerLabel}>配图</Text>
              {it.draft.question_image_path ? (
                <>
                  <Pressable onPress={() => setShowFigureUri(it.draft.question_image_path ?? null)}>
                    <Image source={{ uri: it.draft.question_image_path }} style={styles.figureThumb} />
                  </Pressable>
                  <Pressable
                    style={styles.smallGhostTiny}
                    onPress={() => {
                      setFigureTargetId(it.itemId);
                      setCropPurpose('figure');
                      setShowCrop(true);
                    }}
                  >
                    <Text style={styles.revalidateText}>重截</Text>
                  </Pressable>
                  <Pressable style={styles.smallGhostTiny} onPress={() => void removeFigure(it.itemId)}>
                    <Text style={styles.revalidateText}>移除</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  style={styles.smallGhostTiny}
                  onPress={() => {
                    setFigureTargetId(it.itemId);
                    setCropPurpose('figure');
                    setShowCrop(true);
                  }}
                >
                  <Text style={styles.revalidateText}>截取配图（图形题用）</Text>
                </Pressable>
              )}
            </View>
            {it.issues.length > 0 && <Text style={styles.issues}>{it.issues.join('\n')}</Text>}
          </View>
          )
        ))}
        <View style={{ height: 24 }} />
      </ScrollView>

      <View style={styles.footerBarWrap}>
        <View style={styles.footerTools}>
          <Pressable style={styles.smallGhost} onPress={() => toggleAll(true)}>
            <Text style={styles.smallGhostText}>全选</Text>
          </Pressable>
          <Pressable style={styles.smallGhost} onPress={() => toggleAll(false)}>
            <Text style={styles.smallGhostText}>全不选</Text>
          </Pressable>
          <Pressable
            style={styles.smallGhost}
            onPress={() => {
              setCropPurpose('recognize');
              setShowCrop(true);
            }}
          >
            <Text style={styles.smallGhostText}>框选补识别</Text>
          </Pressable>
          <Pressable style={styles.smallGhost} onPress={() => void runRecognition({ forceHalves: true, merge: true })}>
            <Text style={styles.smallGhostText}>切半补识别</Text>
          </Pressable>
        </View>
        <Pressable style={styles.insertBtn} onPress={() => void insertSelected()}>
          <Text style={styles.insertBtnText}>入库所选（{selectedCount}）</Text>
        </Pressable>
      </View>

      <CropModalHost
        visible={showCrop}
        imageUri={imageUri}
        imageWidth={imageDims.w}
        imageHeight={imageDims.h}
        onCancel={() => setShowCrop(false)}
        onConfirm={(rect) => {
          setShowCrop(false);
          if (cropPurpose === 'figure' && figureTargetId) {
            void attachFigure(figureTargetId, rect);
          } else {
            void runRecognition({ crop: rect, merge: true });
          }
        }}
      />

      <Modal visible={!!showFigureUri} transparent onRequestClose={() => setShowFigureUri(null)}>
        <View style={styles.modalBg}>
          {showFigureUri ? <Image source={{ uri: showFigureUri }} style={styles.modalImage} resizeMode="contain" /> : null}
          <Pressable style={styles.modalClose} onPress={() => setShowFigureUri(null)}>
            <Text style={styles.modalCloseText}>关闭</Text>
          </Pressable>
        </View>
      </Modal>

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

/** 错误态下的框选宿主（仅当有图时可用） */
function CropModalHost(props: {
  visible: boolean;
  imageUri: string;
  imageWidth: number;
  imageHeight: number;
  onCancel: () => void;
  onConfirm: (rect: CropRect) => void;
}) {
  if (!props.imageUri || !props.imageWidth || !props.imageHeight) return null;
  return <CropModal {...props} />;
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
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 8, gap: 8 },
  summary: { flex: 1, fontSize: 12, color: '#66707f' },
  summarySub: { paddingHorizontal: 16, marginTop: 4, fontSize: 11, color: '#98a2b3' },
  jumpBtn: { backgroundColor: '#fdecea', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  jumpBtnText: { color: '#c02a2a', fontSize: 12, fontWeight: '700' },
  list: { flex: 1, marginTop: 8 },
  listContent: { paddingHorizontal: 12 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10 },
  cardUnselected: { opacity: 0.55 },
  cardLocked: { backgroundColor: '#f2f4f8', opacity: 0.9 },
  readonlyStem: { marginTop: 8, fontSize: 13, color: '#66707f', lineHeight: 19 },
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
  figureRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 8 },
  figureThumb: { width: 64, height: 64, borderRadius: 8, backgroundColor: '#eef1f6', borderWidth: 1, borderColor: '#dbe1ec' },
  smallGhostTiny: { borderRadius: 8, borderWidth: 1, borderColor: '#cfd9ea', paddingHorizontal: 10, paddingVertical: 7, backgroundColor: '#fff' },
  revalidateBtn: { backgroundColor: '#e8f0ff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  revalidateText: { color: '#1c5cd6', fontSize: 12, fontWeight: '700' },
  issues: { marginTop: 10, fontSize: 12, color: '#b8860b', lineHeight: 18 },
  footerBarWrap: { paddingHorizontal: 16, paddingBottom: 24, paddingTop: 8, backgroundColor: '#f7f8fa', gap: 10 },
  footerTools: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  insertBtn: {
    backgroundColor: '#1c5cd6',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  insertBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
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
