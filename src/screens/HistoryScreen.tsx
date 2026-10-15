/** 导入历史（方案 A）：每次识别 = 一条记录，可查看/编辑题目、删除整条记录。 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { deleteBatch, listBatchesWithStats, type BatchSummary } from '../db/repo_imports';

export interface HistoryScreenProps {
  db: SQLiteDatabase;
  onBack: () => void;
  onOpenBatch: (batchId: string) => void;
}

function statusText(status: string): string {
  switch (status) {
    case 'running':
    case 'queued':
    case 'paused':
      return '进行中';
    case 'completed':
      return '已完成';
    case 'completed_with_errors':
      return '部分完成';
    case 'cancelled':
      return '已取消';
    default:
      return status;
  }
}

function sourceText(t: string): string {
  switch (t) {
    case 'photo':
      return '拍照';
    case 'gallery':
      return '相册';
    case 'pdf':
      return 'PDF';
    case 'docx':
      return 'DOCX';
    default:
      return t.toUpperCase();
  }
}

export function HistoryScreen({ db, onBack, onOpenBatch }: HistoryScreenProps) {
  const [rows, setRows] = useState<BatchSummary[]>([]);

  const refresh = useCallback(async () => {
    try {
      setRows(await listBatchesWithStats(db));
    } catch {
      setRows([]);
    }
  }, [db]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(
    (id: string) => {
      Alert.alert('删除这条导入记录？', '未入库的草稿将被清除，已入库的题目不受影响。', [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await deleteBatch(db, id);
              await refresh();
            })();
          },
        },
      ]);
    },
    [db, refresh],
  );

  const removeAll = useCallback(() => {
    if (rows.length === 0) return;
    Alert.alert(`删除全部 ${rows.length} 条导入记录？`, '已入库的题目不受影响。', [
      { text: '取消', style: 'cancel' },
      {
        text: '全部删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            for (const r of rows) {
              await deleteBatch(db, r.id);
            }
            await refresh();
          })();
        },
      },
    ]);
  }, [db, rows, refresh]);

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>导入历史</Text>
        <Pressable onPress={removeAll} hitSlop={8}>
          <Text style={styles.removeAll}>全部删除</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {rows.length === 0 && <Text style={styles.empty}>还没有导入记录。识别一次试卷后，这里会保留每次的记录。</Text>}
        {rows.map((r) => (
          <View key={r.id} style={styles.card}>
            <Pressable style={styles.cardMain} onPress={() => onOpenBatch(r.id)}>
              <View style={styles.cardTop}>
                <Text style={styles.cardTime}>{r.created_at.slice(0, 16).replace('T', ' ')}</Text>
                <Text style={styles.cardMeta}>
                  {sourceText(r.source_type)} · {statusText(r.status)}
                </Text>
              </View>
              <Text style={styles.cardStats}>
                共 {r.total} 题 · 已入库 {r.inserted} · 待处理 {r.pending}
                {r.discarded > 0 ? ` · 已跳过 ${r.discarded}` : ''}
              </Text>
            </Pressable>
            <Pressable onPress={() => remove(r.id)} hitSlop={8} style={styles.deleteBtn}>
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
  removeAll: { fontSize: 13, color: '#c0392b' },
  list: { flex: 1, marginTop: 12 },
  listContent: { paddingHorizontal: 12 },
  empty: { marginTop: 40, textAlign: 'center', color: '#98a2b3', fontSize: 13, lineHeight: 20 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, marginBottom: 10, paddingRight: 10 },
  cardMain: { flex: 1, padding: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTime: { fontSize: 14, fontWeight: '700', color: '#333' },
  cardMeta: { fontSize: 12, color: '#66707f' },
  cardStats: { marginTop: 6, fontSize: 12, color: '#66707f' },
  deleteBtn: { paddingVertical: 10, paddingHorizontal: 6 },
  deleteText: { fontSize: 13, color: '#c0392b' },
});
