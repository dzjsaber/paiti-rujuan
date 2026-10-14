/** 技术自检页（M1-A 验证用）：SQLite FTS5/trigram 与图片压缩。真机复验入口。 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as SQLite from 'expo-sqlite';
import { verifyDocParseLibsLoaded } from '../m1a/docparse-verify';

type Line = { ok: boolean; text: string };

const DOCS = [
  '细胞膜的流动镶嵌模型',
  '函数在某点可导必连续',
  '导数的几何意义是切线斜率',
  'DNA双螺旋结构',
  '100以内的质数',
];

export interface SelfTestScreenProps {
  onBack: () => void;
}

export function SelfTestScreen({ onBack }: SelfTestScreenProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [imgInfo, setImgInfo] = useState('');

  const log = useCallback((ok: boolean, text: string) => {
    setLines((prev) => [...prev, { ok, text }]);
  }, []);

  const runSqliteChecks = useCallback(async () => {
    setLines([]);
    try {
      const db = await SQLite.openDatabaseAsync('m1a_check.db');
      const ver = await db.getAllAsync<{ v: string }>('SELECT sqlite_version() AS v');
      log(true, `SQLite 版本：${ver[0]?.v ?? '未知'}`);
      await db.execAsync('DROP TABLE IF EXISTS ft;');
      await db.execAsync("CREATE VIRTUAL TABLE ft USING fts5(content, tokenize='trigram');");
      log(true, 'FTS5 trigram 建表：成功');
      for (const d of DOCS) {
        await db.runAsync('INSERT INTO ft(content) VALUES (?)', d);
      }
      log(true, `插入 ${DOCS.length} 条测试语料`);
      const r1 = await db.getAllAsync('SELECT content FROM ft WHERE ft MATCH ?', '细胞膜');
      log(r1.length > 0, `trigram MATCH「细胞膜」(3字) → ${r1.length} 条`);
      let r2len = -1;
      try {
        const r2 = await db.getAllAsync('SELECT content FROM ft WHERE ft MATCH ?', '函数');
        r2len = r2.length;
      } catch {
        r2len = -1;
      }
      log(true, `trigram MATCH「函数」(2字) → ${r2len < 0 ? '报错（必须走 LIKE 回退）' : r2len + ' 条'}`);
      const r3 = await db.getAllAsync('SELECT content FROM ft WHERE content LIKE ?', '%函数%');
      log(r3.length > 0, `LIKE 回退「函数」 → ${r3.length} 条`);
      const r4 = await db.getAllAsync('SELECT content FROM ft WHERE content LIKE ?', '%DNA%');
      log(r4.length > 0, `LIKE「DNA」 → ${r4.length} 条`);
      const r5 = await db.getAllAsync('SELECT content FROM ft WHERE ft MATCH ?', '导数');
      log(true, `trigram MATCH「导数」(2字) → ${r5.length} 条`);
      for (const note of verifyDocParseLibsLoaded()) {
        log(true, '[打包验证] ' + note);
      }
    } catch (e) {
      log(false, 'SQLite 自检失败：' + String((e as Error)?.message ?? e));
    }
  }, [log]);

  useEffect(() => {
    void runSqliteChecks();
  }, [runSqliteChecks]);

  const pickAndCompress = useCallback(async () => {
    setImgInfo('选择图片中…');
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled || !res.assets?.length) {
        setImgInfo('已取消');
        return;
      }
      const a = res.assets[0];
      const w0 = a.width ?? 0;
      const h0 = a.height ?? 0;
      const before = `原图 ${w0}x${h0} ${a.fileSize ? Math.round(a.fileSize / 1024) + 'KB' : '(大小未知)'}`;
      const longEdge = Math.max(w0, h0);
      const ctx = ImageManipulator.manipulate(a.uri);
      if (longEdge > 2000 && w0 > 0 && h0 > 0) {
        const scale = 2000 / longEdge;
        ctx.resize({ width: Math.round(w0 * scale), height: Math.round(h0 * scale) });
      }
      const ref = await ctx.renderAsync();
      const out = await ref.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
      setImgInfo(`${before}\n压缩后 ${out.width}x${out.height}（长边 ${Math.max(out.width, out.height)}）`);
    } catch (e) {
      setImgInfo('压缩自检失败：' + String((e as Error)?.message ?? e));
    }
  }, []);

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>技术自检</Text>
        <View style={styles.spacer} />
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {lines.map((l, i) => (
          <Text key={i} style={[styles.line, l.ok ? styles.ok : styles.bad]}>
            {l.ok ? '✔ ' : '✘ '}
            {l.text}
          </Text>
        ))}
        {lines.length === 0 && <Text style={styles.line}>自检运行中…</Text>}
      </ScrollView>
      <Pressable style={styles.btn} onPress={() => void runSqliteChecks()}>
        <Text style={styles.btnText}>重新运行 SQLite 自检</Text>
      </Pressable>
      <Pressable style={styles.btn} onPress={() => void pickAndCompress()}>
        <Text style={styles.btnText}>选择图片并压缩（长边 2000 / JPEG 0.85）</Text>
      </Pressable>
      {!!imgInfo && <Text style={styles.imgInfo}>{imgInfo}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff', paddingTop: 64, paddingHorizontal: 16, paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  back: { fontSize: 16, color: '#1c5cd6' },
  title: { fontSize: 18, fontWeight: '700' },
  spacer: { width: 52 },
  list: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 8 },
  listContent: { padding: 10, gap: 6 },
  line: { fontSize: 14, lineHeight: 20, color: '#222' },
  ok: { color: '#0a7d33' },
  bad: { color: '#c02a2a' },
  btn: { marginTop: 10, backgroundColor: '#1c5cd6', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  imgInfo: { marginTop: 10, fontSize: 13, color: '#333', lineHeight: 19 },
});
