/**
 * F8 文档导入：选择文件 → 本地提取 → 隐私确认 → 云端结构化切题 → 确认页入库。
 * 隐私要求（§F8）：向云端发送任何文本前必须明确告知"发送内容/用途/服务商/取消方式"，
 * 并取得本次操作确认；拒绝云端处理时提供"仅本地提取"路径（展示文本供手动整理），
 * 不得暗中发送。分块切题复用 chunker（题目边界优先），答案表映射为本地确定性逻辑。
 */
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { SQLiteDatabase } from 'expo-sqlite';
import { buildDraftsWithF2 } from '../core/draftBuild';
import type { ImportSourceType } from '../core/models';
import { createBatch, createPage, saveDraftItems, updatePageStatus } from '../db/repo_imports';
import { STRUCTURING_PROMPT } from '../prompts/structuring';
import { applyAnswerTable, parseAnswerTable, type MappableDraft } from '../services/documents/answerTable';
import { chunkDocument } from '../services/documents/chunker';
import { extractDocument, type ExtractResult } from '../services/documents/extractors';
import type { LLMService } from '../services/llm/LLMService';
import { TEXT_MODEL } from '../services/llm/LLMService';
import { parseModelText } from '../services/llm/ResponseParser';

type Stage = 'pick' | 'extracting' | 'preview' | 'localOnly' | 'structuring' | 'error';

export interface ImportDocScreenProps {
  db: SQLiteDatabase;
  llm: LLMService;
  onBack: () => void;
  onOpenReview: (batchId: string) => void;
}

function sourceTypeFromName(name: string): ImportSourceType {
  const l = name.toLowerCase();
  if (l.endsWith('.pdf')) return 'pdf';
  if (l.endsWith('.docx')) return 'docx';
  if (l.endsWith('.md')) return 'md';
  return 'txt';
}

export function ImportDocScreen({ db, llm, onBack, onOpenReview }: ImportDocScreenProps) {
  const [stage, setStage] = useState<Stage>('pick');
  const [fileName, setFileName] = useState('');
  const [extract, setExtract] = useState<ExtractResult | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [showPrivacy, setShowPrivacy] = useState(false);
  const cancelRef = useRef(false);

  const pick = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'text/plain',
          'text/markdown',
        ],
        // 由应用自行复制（见 extractors.materialize）：DocumentPicker 的缓存复制
        // 在部分来源（微信/文件管理器）下会产生不可读文件
        copyToCacheDirectory: false,
        multiple: false,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      setFileName(a.name);
      setStage('extracting');
      const r = await extractDocument(a.uri, a.name);
      setExtract(r);
      setStage('preview');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setStage('error');
    }
  }, []);

  const askKeep = useCallback(
    (count: number) =>
      new Promise<boolean>((resolve) => {
        Alert.alert('已取消', `已成功处理 ${count} 个片段，是否保留已识别的题目？`, [
          { text: '丢弃', style: 'destructive', onPress: () => resolve(false) },
          { text: '保留', onPress: () => resolve(true) },
        ]);
      }),
    [],
  );

  const startStructuring = useCallback(async () => {
    setShowPrivacy(false);
    if (!extract) return;
    setStage('structuring');
    cancelRef.current = false;
    try {
      const text = extract.text;
      const chunks = chunkDocument(text);
      if (chunks.length === 0) throw new Error('文档中没有可处理的文本');
      const allDrafts: unknown[] = [];
      const failures: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        if (cancelRef.current) {
          if (allDrafts.length > 0 && (await askKeep(allDrafts.length))) break;
          setStage('preview');
          return;
        }
        setProgress(`正在结构化切题 ${i + 1}/${chunks.length} …`);
        const r = await llm.complete(`${STRUCTURING_PROMPT}\n\n--- 文档片段 ---\n${chunks[i].text}`, {
          model: TEXT_MODEL,
          temperature: 0.1,
          maxTokens: 8192,
          timeoutMs: 120000,
        });
        if (!r.ok) {
          failures.push(`第 ${i + 1} 块：${r.error?.userMessage ?? '请求失败'}`);
          continue;
        }
        const parsed = parseModelText(r.content ?? '');
        if (parsed.drafts) {
          allDrafts.push(...parsed.drafts);
        } else {
          failures.push(`第 ${i + 1} 块：模型输出无法解析`);
        }
      }
      if (allDrafts.length === 0) {
        throw new Error('未能从文档中提取到题目' + (failures.length > 0 ? `（${failures[0]}）` : ''));
      }

      // 答案表映射（本地确定性逻辑，在 F2 之前写入 answer）
      const table = parseAnswerTable(text);
      const mappable = allDrafts as MappableDraft[];
      const mapResult = applyAnswerTable(mappable, table);

      const { drafts } = buildDraftsWithF2(allDrafts, { sourceEngine: 'doc', sourceImagePath: null, sourcePage: null });
      const sourceType = sourceTypeFromName(fileName);
      const batchId = await createBatch(db, sourceType);
      const pageId = await createPage(db, batchId, null, null);
      await saveDraftItems(db, batchId, pageId, drafts, 'draft', null);
      await updatePageStatus(db, pageId, 'needs_review');
      if (failures.length > 0) {
        Alert.alert('部分片段处理失败', failures.join('\n').slice(0, 500));
      }
      if (table.size > 0) {
        Alert.alert('答案表映射完成', `从文末答案表映射到 ${mapResult.mapped} 道题的答案${mapResult.conflicts > 0 ? `，${mapResult.conflicts} 处冲突需人工确认` : ''}。`);
      }
      onOpenReview(batchId);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setStage('error');
    }
  }, [db, llm, extract, fileName, askKeep, onOpenReview]);

  // ---------------------------------------------------------------- 渲染
  if (stage === 'pick') {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={onBack} hitSlop={8}>
            <Text style={styles.back}>← 返回</Text>
          </Pressable>
          <Text style={styles.title}>文档导入</Text>
          <View style={styles.spacer} />
        </View>
        <View style={styles.center}>
          <Text style={styles.centerText}>支持 PDF / DOCX / TXT / MD（文字版）</Text>
          <Text style={styles.centerHint}>
            纯文本提取在本地完成；结构化切题需要把文本片段发送给智谱 AI（发送前会再次征求你确认）。{'\n'}
            扫描版（图片型）文件请改用"拍照识别"。
          </Text>
          <Pressable style={styles.primaryBtn} onPress={() => void pick()}>
            <Text style={styles.primaryBtnText}>选择文件</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (stage === 'extracting') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.centerText}>正在本地提取文本…</Text>
      </View>
    );
  }

  if (stage === 'structuring') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.centerText}>{progress}</Text>
        <Pressable
          style={styles.ghostBtn}
          onPress={() => {
            cancelRef.current = true;
          }}
        >
          <Text style={styles.ghostBtnText}>取消</Text>
        </Pressable>
      </View>
    );
  }

  if (stage === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>导入未完成</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.primaryBtn} onPress={() => setStage(extract ? 'preview' : 'pick')}>
          <Text style={styles.primaryBtnText}>返回重试</Text>
        </Pressable>
        <Pressable style={styles.ghostBtn} onPress={onBack}>
          <Text style={styles.ghostBtnText}>返回首页</Text>
        </Pressable>
      </View>
    );
  }

  if (stage === 'localOnly' && extract) {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={() => setStage('preview')} hitSlop={8}>
            <Text style={styles.back}>← 返回</Text>
          </Pressable>
          <Text style={styles.title}>本地提取结果</Text>
          <View style={styles.spacer} />
        </View>
        <Text style={styles.localHint}>以下文本完全来自本地提取，未发送任何网络请求。可长按选择复制，手动整理成题目。</Text>
        <ScrollView style={styles.previewBox}>
          <Text style={styles.previewText} selectable>
            {extract.text}
          </Text>
        </ScrollView>
      </View>
    );
  }

  // preview
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>提取预览</Text>
        <View style={styles.spacer} />
      </View>
      <Text style={styles.fileName}>
        {fileName} · {extract ? `${extract.text.length} 字符` : ''}
        {extract?.pageCount ? ` · ${extract.pageCount} 页` : ''}
      </Text>
      {(extract?.warnings ?? []).map((w, i) => (
        <Text key={i} style={styles.warn}>
          ⚠ {w}
        </Text>
      ))}
      <ScrollView style={styles.previewBox}>
        <Text style={styles.previewText}>
          {(extract?.text ?? '').slice(0, 3000)}
          {(extract?.text.length ?? 0) > 3000 ? '\n\n…（仅预览前 3000 字符，处理时会使用全文）' : ''}
        </Text>
      </ScrollView>
      <Pressable style={styles.primaryBtnWide} onPress={() => setShowPrivacy(true)}>
        <Text style={styles.primaryBtnText}>云端结构化切题</Text>
      </Pressable>
      <Pressable style={styles.ghostBtnWide} onPress={() => setStage('localOnly')}>
        <Text style={styles.ghostBtnText}>仅本地提取（不联网，手动整理）</Text>
      </Pressable>

      <Modal visible={showPrivacy} transparent onRequestClose={() => setShowPrivacy(false)}>
        <View style={styles.privacyBg}>
          <View style={styles.privacyCard}>
            <Text style={styles.privacyTitle}>将向智谱 AI 发送文本</Text>
            <Text style={styles.privacyBody}>
              · 发送内容：从该文档提取的纯文本片段（切题所需，不含原文件本身）{'\n'}
              · 用途：结构化识别题目 / 选项 / 答案{'\n'}
              · 服务商：智谱 AI（open.bigmodel.cn）{'\n'}
              · 取消方式：处理中可随时点击"取消"，未开始的片段不会发送
            </Text>
            <Pressable style={styles.primaryBtnWide} onPress={() => void startStructuring()}>
              <Text style={styles.primaryBtnText}>同意并继续</Text>
            </Pressable>
            <Pressable
              style={styles.ghostBtnWide}
              onPress={() => {
                setShowPrivacy(false);
                setStage('localOnly');
              }}
            >
              <Text style={styles.ghostBtnText}>仅本地提取（不联网）</Text>
            </Pressable>
            <Pressable style={styles.ghostBtnWide} onPress={() => setShowPrivacy(false)}>
              <Text style={styles.ghostBtnText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 60, paddingHorizontal: 16, paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { fontSize: 15, color: '#1c5cd6' },
  title: { fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  spacer: { width: 52 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f7f8fa', paddingHorizontal: 28 },
  centerText: { marginTop: 14, fontSize: 16, color: '#333', textAlign: 'center' },
  centerHint: { marginTop: 12, fontSize: 12, color: '#8a94a6', lineHeight: 19, textAlign: 'center' },
  errorTitle: { fontSize: 18, fontWeight: '700', color: '#c02a2a' },
  errorText: { marginTop: 12, fontSize: 14, color: '#444', lineHeight: 21, textAlign: 'center' },
  fileName: { marginTop: 12, fontSize: 13, color: '#66707f' },
  warn: { marginTop: 8, fontSize: 12, color: '#b8860b', lineHeight: 18 },
  previewBox: { flex: 1, marginTop: 12, backgroundColor: '#fff', borderRadius: 10, padding: 12 },
  previewText: { fontSize: 13, color: '#333', lineHeight: 20 },
  localHint: { marginTop: 12, fontSize: 12, color: '#66707f', lineHeight: 18 },
  primaryBtn: { marginTop: 28, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 44 },
  primaryBtnWide: { marginTop: 14, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  ghostBtn: { marginTop: 14, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 44, borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff' },
  ghostBtnWide: { marginTop: 10, borderRadius: 12, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff' },
  ghostBtnText: { color: '#31518a', fontSize: 14 },
  privacyBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', paddingHorizontal: 20 },
  privacyCard: { backgroundColor: '#fff', borderRadius: 16, padding: 18 },
  privacyTitle: { fontSize: 17, fontWeight: '800', color: '#1a1a1a' },
  privacyBody: { marginTop: 12, fontSize: 13, color: '#444', lineHeight: 21 },
});
