/** F5 错题本：答错自动收录；支持顺序/随机重刷；重刷答对自动移出（历史保留）。 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { DEFAULT_BANK_ID } from '../db/database';
import { listWrongBook, type WrongBookEntry } from '../db/repo_practice';

export interface WrongBookScreenProps {
  db: SQLiteDatabase;
  onBack: () => void;
  onPractice: (order: 'seq' | 'random') => void;
}

export function WrongBookScreen({ db, onBack, onPractice }: WrongBookScreenProps) {
  const [entries, setEntries] = useState<WrongBookEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      setEntries(await listWrongBook(db, DEFAULT_BANK_ID));
    } catch {
      setEntries([]);
    }
  }, [db]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>错题本</Text>
        <Text style={styles.count}>{entries.length} 题</Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {entries.length === 0 && (
          <Text style={styles.empty}>错题本是空的。刷题时答错的题目会自动收录到这里；重刷答对后自动移出。</Text>
        )}
        {entries.map((e) => (
          <View key={e.question_id} style={styles.card}>
            <Text style={styles.stem} numberOfLines={2}>
              {e.stem}
            </Text>
            <Text style={styles.meta}>
              错 {e.wrong_count} 次
              {e.last_wrong_at ? ` · 上次 ${e.last_wrong_at.slice(5, 16).replace('T', ' ')}` : ''}
            </Text>
          </View>
        ))}
        <View style={{ height: 90 }} />
      </ScrollView>

      {entries.length > 0 && (
        <View style={styles.footer}>
          <Pressable style={styles.ghostBtn} onPress={() => onPractice('seq')}>
            <Text style={styles.ghostBtnText}>顺序重刷</Text>
          </Pressable>
          <Pressable style={styles.primaryBtnSmall} onPress={() => onPractice('random')}>
            <Text style={styles.primaryBtnText}>随机重刷</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 64 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  back: { fontSize: 15, color: '#1c5cd6' },
  title: { fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  count: { fontSize: 13, color: '#66707f' },
  list: { flex: 1, marginTop: 12 },
  listContent: { paddingHorizontal: 12 },
  empty: { marginTop: 40, textAlign: 'center', color: '#98a2b3', fontSize: 13, lineHeight: 20, paddingHorizontal: 24 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10 },
  stem: { fontSize: 14, color: '#222', lineHeight: 20 },
  meta: { marginTop: 8, fontSize: 12, color: '#c0392b' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingBottom: 26, paddingTop: 10, backgroundColor: '#f7f8fa' },
  ghostBtn: { flex: 1, borderRadius: 12, borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff', alignItems: 'center', paddingVertical: 14 },
  ghostBtnText: { color: '#31518a', fontSize: 15 },
  primaryBtnSmall: { flex: 1, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
