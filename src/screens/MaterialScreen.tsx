/**
 * F9a 教材库：导入（PDF/DOCX/TXT/MD，本地提取 + 分块 + FTS5 索引，默认不调用云端）、
 * 列表、来源查看、删除（级联清理分块/索引/本地原文件）。
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  addMaterialChunks,
  createMaterial,
  deleteMaterial,
  listMaterialChunks,
  listMaterials,
  type MaterialChunkRow,
  type MaterialSummary,
} from '../db/repo_materials';
import { MATERIAL_BOUNDARY, chunkDocument } from '../services/documents/chunker';
import { extractDocument } from '../services/documents/extractors';

type Stage = 'list' | 'importing' | 'view';

export interface MaterialScreenProps {
  db: SQLiteDatabase;
  onBack: () => void;
}

/** 原文件复制到应用私有目录（document/materials/） */
async function saveMaterialFile(srcUri: string, name: string): Promise<string | null> {
  try {
    const dir = `${FileSystemLegacy.documentDirectory}materials/`;
    const info = await FileSystemLegacy.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystemLegacy.makeDirectoryAsync(dir, { intermediates: true });
    }
    const safe = name.replace(/[^\w.\u4e00-\u9fa5-]/g, '_');
    const dest = `${dir}${Date.now()}_${safe}`;
    await FileSystemLegacy.copyAsync({ from: srcUri, to: dest });
    return dest;
  } catch {
    return null;
  }
}

export function MaterialScreen({ db, onBack }: MaterialScreenProps) {
  const [stage, setStage] = useState<Stage>('list');
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [progress, setProgress] = useState('');
  const [viewing, setViewing] = useState<{ name: string; chunks: MaterialChunkRow[] } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMaterials(await listMaterials(db));
    } catch {
      setMaterials([]);
    }
  }, [db]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const importOne = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/vnd.ms-powerpoint',
          'application/msword',
          'text/plain',
          'text/markdown',
        ],
        copyToCacheDirectory: false,
        multiple: false,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      setStage('importing');
      setProgress('正在本地提取文本…');
      const r = await extractDocument(a.uri, a.name);
      if (!r.text.trim()) {
        throw new Error('未提取到文本。' + (r.warnings[0] ?? ''));
      }
      setProgress('正在保存原文件…');
      const savedPath = await saveMaterialFile(a.uri, a.name);
      setProgress('正在分块并建立索引…');
      const chunks = chunkDocument(r.text, 800, 100, MATERIAL_BOUNDARY);
      const id = await createMaterial(db, a.name, savedPath);
      const n = await addMaterialChunks(
        db,
        id,
        chunks.map((c) => ({ content: c.text, sourceLoc: `字符 ${c.charStart}-${c.charEnd}` })),
      );
      await refresh();
      setStage('list');
      const warn = r.warnings.length > 0 ? '\n\n提示：' + r.warnings.join('\n') : '';
      Alert.alert('导入完成', `${a.name}\n共 ${n} 段（每段约 500-800 字符）${warn}`);
    } catch (e) {
      setStage('list');
      Alert.alert('导入失败', String((e as Error)?.message ?? e));
    }
  }, [db, refresh]);

  const remove = useCallback(
    (m: MaterialSummary) => {
      Alert.alert('删除这本教材？', '教材原文、分段与索引将一并清理，无法恢复。', [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await deleteMaterial(db, m.id, m.file_path);
                await refresh();
              } catch (e) {
                Alert.alert('删除失败', String((e as Error)?.message ?? e));
              }
            })();
          },
        },
      ]);
    },
    [db, refresh],
  );

  const openView = useCallback(
    async (m: MaterialSummary) => {
      try {
        const chunks = await listMaterialChunks(db, m.id, 200, 0);
        setViewing({ name: m.name, chunks });
        setStage('view');
      } catch (e) {
        Alert.alert('读取失败', String((e as Error)?.message ?? e));
      }
    },
    [db],
  );

  if (stage === 'importing') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.centerText}>{progress}</Text>
      </View>
    );
  }

  if (stage === 'view' && viewing) {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={() => setStage('list')} hitSlop={8}>
            <Text style={styles.back}>← 返回</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            分段预览
          </Text>
          <View style={styles.spacer} />
        </View>
        <Text style={styles.viewName}>
          {viewing.name} · 共 {viewing.chunks.length} 段（最多显示 200 段）
        </Text>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {viewing.chunks.map((c, i) => (
            <View key={c.id} style={styles.chunkCard}>
              <Text style={styles.chunkMeta}>
                #{i + 1} · {c.source_loc ?? ''}
              </Text>
              <Text style={styles.chunkText} numberOfLines={4}>
                {c.content}
              </Text>
            </View>
          ))}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>教材库</Text>
        <Pressable onPress={() => void importOne()} hitSlop={8}>
          <Text style={styles.importBtn}>＋ 导入</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>教材用于 AI 讲解的知识引用（后续功能）。删除教材会同时清理分段、索引与原文件。</Text>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {materials.length === 0 && (
          <Text style={styles.empty}>还没有教材。点右上角"导入"，支持 PDF / DOCX / PPTX / TXT / MD（文字版）。</Text>
        )}
        {materials.map((m) => (
          <View key={m.id} style={styles.card}>
            <Pressable style={styles.cardMain} onPress={() => void openView(m)}>
              <Text style={styles.cardName} numberOfLines={1}>
                {m.name}
              </Text>
              <Text style={styles.cardMeta}>
                {m.chunk_count} 段 · {m.created_at.slice(0, 10)}
                {m.file_path ? ' · 原文件已保存' : ' · 原文件未保存'}
              </Text>
            </Pressable>
            <Pressable onPress={() => remove(m)} hitSlop={8} style={styles.deleteBtn}>
              <Text style={styles.deleteText}>删除</Text>
            </Pressable>
          </View>
        ))}
        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 64 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  back: { fontSize: 15, color: '#1c5cd6' },
  title: { fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  spacer: { width: 52 },
  importBtn: { fontSize: 15, color: '#1c5cd6', fontWeight: '700' },
  hint: { paddingHorizontal: 16, marginTop: 10, fontSize: 12, color: '#8a94a6', lineHeight: 18 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f7f8fa', paddingHorizontal: 28 },
  centerText: { marginTop: 14, fontSize: 16, color: '#333' },
  centerHint: { marginTop: 10, fontSize: 12, color: '#8a94a6', textAlign: 'center' },
  viewName: { paddingHorizontal: 16, marginTop: 10, fontSize: 13, color: '#66707f' },
  list: { flex: 1, marginTop: 10 },
  listContent: { paddingHorizontal: 12 },
  empty: { marginTop: 40, textAlign: 'center', color: '#98a2b3', fontSize: 13, lineHeight: 20, paddingHorizontal: 24 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, marginBottom: 10, paddingRight: 10 },
  cardMain: { flex: 1, padding: 12 },
  cardName: { fontSize: 14, fontWeight: '700', color: '#222' },
  cardMeta: { marginTop: 6, fontSize: 12, color: '#66707f' },
  deleteBtn: { paddingVertical: 10, paddingHorizontal: 6 },
  deleteText: { fontSize: 13, color: '#c0392b' },
  chunkCard: { backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8 },
  chunkMeta: { fontSize: 11, color: '#98a2b3' },
  chunkText: { marginTop: 6, fontSize: 13, color: '#333', lineHeight: 19 },
});
