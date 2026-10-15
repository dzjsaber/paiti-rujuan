/**
 * F9a 教材库：导入（PDF/DOCX/TXT/MD，本地提取 + 分块 + FTS5 索引，默认不调用云端）、
 * 列表、来源查看、删除（级联清理分块/索引/本地原文件）。
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  addMaterialChunks,
  addMaterialImages,
  createMaterial,
  deleteMaterial,
  listMaterialChunks,
  listMaterialImages,
  listMaterials,
  type MaterialChunkRow,
  type MaterialImageRow,
  type MaterialSummary,
} from '../db/repo_materials';
import { MATERIAL_BOUNDARY, chunkDocument } from '../services/documents/chunker';
import type { ExtractedImage } from '../services/documents/docCommon';
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

const B64_ENC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(d: Uint8Array): string {
  let out = '';
  for (let i = 0; i < d.length; i += 3) {
    const b1 = d[i];
    const b2 = i + 1 < d.length ? d[i + 1] : -1;
    const b3 = i + 2 < d.length ? d[i + 2] : -1;
    out += B64_ENC[b1 >> 2];
    out += B64_ENC[((b1 & 3) << 4) | ((b2 >= 0 ? b2 : 0) >> 4)];
    out += b2 >= 0 ? B64_ENC[((b2 & 15) << 2) | ((b3 >= 0 ? b3 : 0) >> 6)] : '=';
    out += b3 >= 0 ? B64_ENC[b3 & 63] : '=';
  }
  return out;
}

/** 内嵌图片写入私有目录 materials/images/<materialId>/（单张失败跳过，不阻塞导入） */
async function saveMaterialImages(
  materialId: string,
  images: ExtractedImage[],
): Promise<{ pageNo: number | null; filePath: string }[]> {
  const dir = `${FileSystemLegacy.documentDirectory}materials/images/${materialId}/`;
  try {
    const info = await FileSystemLegacy.getInfoAsync(dir);
    if (!info.exists) await FileSystemLegacy.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    return [];
  }
  const out: { pageNo: number | null; filePath: string }[] = [];
  let idx = 0;
  for (const img of images) {
    try {
      idx += 1;
      const filePath = `${dir}img_${img.pageNo ?? 'x'}_${idx}.${img.ext}`;
      await FileSystemLegacy.writeAsStringAsync(filePath, bytesToBase64(img.data), {
        encoding: FileSystemLegacy.EncodingType.Base64,
      });
      out.push({ pageNo: img.pageNo, filePath });
    } catch {
      /* 单张失败跳过 */
    }
  }
  return out;
}

export function MaterialScreen({ db, onBack }: MaterialScreenProps) {
  const [stage, setStage] = useState<Stage>('list');
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [progress, setProgress] = useState('');
  const [viewing, setViewing] = useState<{ name: string; chunks: MaterialChunkRow[]; images: MaterialImageRow[] } | null>(null);
  const [viewingImageUri, setViewingImageUri] = useState<string | null>(null);

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
      // 内嵌图片（PPT/PPTX 支持）
      let imgSaved = 0;
      if (r.images && r.images.length > 0) {
        setProgress(`正在保存 ${r.images.length} 张内嵌图片…`);
        const saved = await saveMaterialImages(id, r.images);
        imgSaved = await addMaterialImages(db, id, saved);
      }
      await refresh();
      setStage('list');
      const warn = r.warnings.length > 0 ? '\n\n提示：' + r.warnings.join('\n') : '';
      Alert.alert('导入完成', `${a.name}\n共 ${n} 段${imgSaved > 0 ? `、${imgSaved} 张内嵌图片` : ''}（每段约 500-800 字符）${warn}`);
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
        const images = await listMaterialImages(db, m.id);
        setViewing({ name: m.name, chunks, images });
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
          {viewing.name} · 共 {viewing.chunks.length} 段{viewing.images.length > 0 ? ` · ${viewing.images.length} 张内嵌图片` : ''}
        </Text>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {viewing.images.length > 0 && (
            <View style={styles.imgSection}>
              <Text style={styles.sectionTitle}>内嵌图片（点击放大）</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
                {viewing.images.map((img) => (
                  <Pressable key={img.id} onPress={() => setViewingImageUri(img.file_path)}>
                    <View style={styles.thumbWrap}>
                      <Image source={{ uri: img.file_path }} style={styles.thumb} resizeMode="cover" />
                      <Text style={styles.thumbLabel}>{img.page_no ? `第 ${img.page_no} 页` : '素材图'}</Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}
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
        <Modal visible={!!viewingImageUri} transparent onRequestClose={() => setViewingImageUri(null)}>
          <View style={styles.modalBg}>
            {viewingImageUri ? <Image source={{ uri: viewingImageUri }} style={styles.modalImage} resizeMode="contain" /> : null}
            <Pressable style={styles.modalClose} onPress={() => setViewingImageUri(null)}>
              <Text style={styles.modalCloseText}>关闭</Text>
            </Pressable>
          </View>
        </Modal>
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
      <Text style={styles.hint}>
        教材用于 AI 讲解的引用。在题库管理或入库确认页可为题库绑定教材（绑定后讲解只依据绑定教材，未绑定则检索全部教材）。
        删除教材会同时清理分段、索引与原文件。
      </Text>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {materials.length === 0 && (
          <Text style={styles.empty}>还没有教材。点右上角"导入"，支持 PDF / DOCX / PPT / PPTX / TXT / MD（文字版）。</Text>
        )}
        {materials.map((m) => (
          <View key={m.id} style={styles.card}>
            <Pressable style={styles.cardMain} onPress={() => void openView(m)}>
              <Text style={styles.cardName} numberOfLines={1}>
                {m.name}
              </Text>
              <Text style={styles.cardMeta}>
                {m.chunk_count} 段{m.image_count > 0 ? ` · ${m.image_count} 张图` : ''} · {m.created_at.slice(0, 10)}
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
  imgSection: { marginBottom: 6 },
  sectionTitle: { fontSize: 12, color: '#66707f', marginBottom: 8 },
  thumbRow: { gap: 10, paddingRight: 8 },
  thumbWrap: { alignItems: 'center' },
  thumb: { width: 128, height: 88, borderRadius: 8, backgroundColor: '#eef1f6' },
  thumbLabel: { marginTop: 4, fontSize: 11, color: '#8a94a6' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  modalImage: { width: '100%', height: '85%' },
  modalClose: { marginTop: 16, paddingVertical: 10, paddingHorizontal: 32, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)' },
  modalCloseText: { color: '#fff', fontSize: 15 },
});
