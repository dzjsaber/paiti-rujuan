/**
 * F6 数据备份与恢复：
 * 导出为版本化 JSON（经系统分享保存到用户选择的位置）；导入前校验并预览统计；
 * 恢复按稳定 ID 合并、单事务执行（失败自动回滚）。
 */
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { SQLiteDatabase } from 'expo-sqlite';
import { buildBackup, restoreBackup, validateBackup } from '../db/backup';
import { readTextFile } from '../services/documents/extractors';

export interface BackupScreenProps {
  db: SQLiteDatabase;
  onBack: () => void;
}

export function BackupScreen({ db, onBack }: BackupScreenProps) {
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const doExport = useCallback(async () => {
    setBusy(true);
    try {
      const backup = await buildBackup(db);
      const path = `${FileSystemLegacy.cacheDirectory}paiti_backup_${Date.now()}.json`;
      await FileSystemLegacy.writeAsStringAsync(path, JSON.stringify(backup));
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('无法分享', '当前设备不支持系统分享，导出未完成');
        return;
      }
      await Sharing.shareAsync(path, { mimeType: 'application/json', dialogTitle: '导出题库备份' });
      setLastResult(
        `已生成备份：${backup.counts.questions} 题 · ${backup.counts.wrongBook} 条错题 · ${backup.counts.practiceLog} 条做题记录`,
      );
    } catch (e) {
      Alert.alert('导出失败', String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [db]);

  const doImport = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'text/plain', '*/*'],
        copyToCacheDirectory: false,
        multiple: false,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      setBusy(true);
      const text = await readTextFile(a.uri);
      const v = validateBackup(text);
      if (!v.ok) {
        Alert.alert('无法导入', v.error);
        return;
      }
      const c = v.backup.counts;
      Alert.alert(
        '确认导入这个备份？',
        `导出时间：${v.backup.exportedAt.slice(0, 16).replace('T', ' ')}\n` +
          `含 ${c.questions} 题 · ${c.wrongBook} 条错题 · ${c.practiceLog} 条做题记录\n\n` +
          '已存在的题目会跳过；导入失败会自动回滚，不会留下半截数据。',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '导入',
            onPress: () => {
              void (async () => {
                setBusy(true);
                try {
                  const stats = await restoreBackup(db, v.backup);
                  setLastResult(
                    `导入完成：新增 ${stats.questionsAdded} 题（跳过已有 ${stats.questionsSkipped}）· 错题 +${stats.wrongMerged} · 做题记录 +${stats.logsAdded}`,
                  );
                } catch (e) {
                  Alert.alert('导入失败（已回滚）', String((e as Error)?.message ?? e));
                } finally {
                  setBusy(false);
                }
              })();
            },
          },
        ],
      );
    } catch (e) {
      Alert.alert('导入失败', String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [db]);

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>数据备份</Text>
        <View style={styles.spacer} />
      </View>

      <Text style={styles.section}>备份内容</Text>
      <Text style={styles.body}>
        题库题目、错题本、做题记录与设置，导出为一个 JSON 文件（通过系统分享保存到你选择的位置）。
        {'\n\n'}
        不包含：试卷原图、题目配图与教材文件——这些文件较大且跨设备路径无效，恢复后需重新关联。
      </Text>

      <Pressable style={[styles.primaryBtn, busy && styles.disabled]} onPress={() => void doExport()} disabled={busy}>
        <Text style={styles.primaryBtnText}>导出备份</Text>
      </Pressable>
      <Pressable style={[styles.ghostBtn, busy && styles.disabled]} onPress={() => void doImport()} disabled={busy}>
        <Text style={styles.ghostBtnText}>导入备份（恢复）</Text>
      </Pressable>

      {busy && <ActivityIndicator style={styles.busy} />}
      {lastResult && <Text style={styles.result}>{lastResult}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 64, paddingHorizontal: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { fontSize: 15, color: '#1c5cd6' },
  title: { fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  spacer: { width: 52 },
  section: { marginTop: 26, fontSize: 15, fontWeight: '700', color: '#333' },
  body: { marginTop: 10, fontSize: 13, color: '#556', lineHeight: 21 },
  primaryBtn: { marginTop: 26, backgroundColor: '#1c5cd6', borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  ghostBtn: { marginTop: 12, borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#cfd9ea', backgroundColor: '#fff' },
  ghostBtnText: { color: '#31518a', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  busy: { marginTop: 18 },
  result: { marginTop: 18, fontSize: 13, color: '#0a7d33', lineHeight: 20 },
  scrollContent: { paddingBottom: 60 },
});
