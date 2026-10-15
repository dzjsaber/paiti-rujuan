/** 首页：题库统计 + 拍照/相册导入入口 + 设置入口。 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { SQLiteDatabase } from 'expo-sqlite';
import { DEFAULT_BANK_ID } from '../db/database';
import { countWrongBook } from '../db/repo_practice';
import { countQuestions } from '../db/repo_questions';

export interface ReviewParams {
  imagePath: string;
  imageWidth?: number;
  imageHeight?: number;
  sourceType: 'photo' | 'gallery';
}

export interface HomeScreenProps {
  db: SQLiteDatabase;
  onOpenReview: (p: ReviewParams) => void;
  onOpenSettings: () => void;
  /** 导入历史（每次识别一条记录） */
  onOpenHistory: () => void;
  /** 开始刷题（题库） */
  onOpenPractice: () => void;
  /** 错题本 */
  onOpenWrongBook: () => void;
  /** 题库管理（补答案、编辑、删除） */
  onOpenBank: () => void;
  /** 文档导入（PDF/DOCX/TXT/MD） */
  onOpenDocImport: () => void;
  /** 教材库（F9a） */
  onOpenMaterials: () => void;
}

export function HomeScreen({
  db,
  onOpenReview,
  onOpenSettings,
  onOpenHistory,
  onOpenPractice,
  onOpenWrongBook,
  onOpenBank,
  onOpenDocImport,
  onOpenMaterials,
}: HomeScreenProps) {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [wrongCount, setWrongCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setCount(await countQuestions(db, DEFAULT_BANK_ID));
    } catch {
      setCount(null);
    }
    try {
      setWrongCount(await countWrongBook(db, DEFAULT_BANK_ID));
    } catch {
      setWrongCount(0);
    }
  }, [db]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const takePhoto = useCallback(async () => {
    setBusy(true);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('需要相机权限', '请在系统设置中允许本应用使用相机后重试。');
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ quality: 1 });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      onOpenReview({
        imagePath: a.uri,
        imageWidth: a.width ?? undefined,
        imageHeight: a.height ?? undefined,
        sourceType: 'photo',
      });
    } catch (e) {
      Alert.alert('拍照失败', String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [onOpenReview]);

  const pickFromGallery = useCallback(async () => {
    setBusy(true);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      onOpenReview({
        imagePath: a.uri,
        imageWidth: a.width ?? undefined,
        imageHeight: a.height ?? undefined,
        sourceType: 'gallery',
      });
    } catch (e) {
      Alert.alert('选择图片失败', String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [onOpenReview]);

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <Text style={styles.title}>拍题入卷</Text>
        <Pressable onPress={onOpenSettings} style={styles.settingsBtn} hitSlop={8}>
          <Text style={styles.settingsText}>设置</Text>
        </Pressable>
      </View>

      <View style={styles.statCard}>
        <Text style={styles.statNumber}>{count === null ? '—' : count}</Text>
        <Text style={styles.statLabel}>题库题目数（默认题库）</Text>
      </View>

      <Pressable style={[styles.bigBtn, busy && styles.bigBtnDisabled]} onPress={() => void takePhoto()} disabled={busy}>
        <Text style={styles.bigBtnText}>拍照识别</Text>
        <Text style={styles.bigBtnHint}>对准整页试卷拍照，自动提取题目</Text>
      </Pressable>

      <Pressable style={[styles.bigBtnAlt, busy && styles.bigBtnDisabled]} onPress={() => void pickFromGallery()} disabled={busy}>
        <Text style={styles.bigBtnAltText}>从相册选择</Text>
        <Text style={styles.bigBtnAltHint}>选择已有的试卷照片</Text>
      </Pressable>

      <Pressable style={styles.docBtn} onPress={onOpenDocImport}>
        <Text style={styles.docBtnText}>导入文档（PDF / DOCX / TXT / MD）</Text>
      </Pressable>

      <Pressable style={styles.docBtn} onPress={onOpenMaterials}>
        <Text style={styles.docBtnText}>教材库（本地知识库，供 AI 讲解引用）</Text>
      </Pressable>

      {busy && <ActivityIndicator style={styles.busy} />}

      <View style={styles.rowBtns}>
        <Pressable style={styles.rowBtn} onPress={onOpenPractice}>
          <Text style={styles.rowBtnText}>开始刷题</Text>
        </Pressable>
        <Pressable style={styles.rowBtn} onPress={onOpenWrongBook}>
          <Text style={styles.rowBtnText}>错题本{wrongCount > 0 ? `（${wrongCount}）` : ''}</Text>
        </Pressable>
      </View>

      <View style={styles.rowBtns}>
        <Pressable style={styles.rowBtn} onPress={onOpenHistory}>
          <Text style={styles.rowBtnText}>导入历史</Text>
        </Pressable>
        <Pressable style={styles.rowBtn} onPress={onOpenBank}>
          <Text style={styles.rowBtnText}>题库管理</Text>
        </Pressable>
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f7f8fa', paddingTop: 64, paddingHorizontal: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 26, fontWeight: '800', color: '#1a1a1a' },
  settingsBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: '#e8ecf3' },
  settingsText: { fontSize: 14, color: '#31518a' },
  statCard: { marginTop: 24, backgroundColor: '#fff', borderRadius: 12, paddingVertical: 18, alignItems: 'center' },
  statNumber: { fontSize: 32, fontWeight: '800', color: '#1c5cd6' },
  statLabel: { marginTop: 4, fontSize: 13, color: '#777' },
  bigBtn: { marginTop: 28, backgroundColor: '#1c5cd6', borderRadius: 14, paddingVertical: 18, paddingHorizontal: 20, alignItems: 'center' },
  bigBtnDisabled: { opacity: 0.6 },
  bigBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  bigBtnHint: { color: '#d7e3ff', fontSize: 12, marginTop: 4 },
  bigBtnAlt: { marginTop: 14, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 18, paddingHorizontal: 20, alignItems: 'center', borderWidth: 1, borderColor: '#cfd9ea' },
  bigBtnAltText: { color: '#1c5cd6', fontSize: 18, fontWeight: '700' },
  bigBtnAltHint: { color: '#8a94a6', fontSize: 12, marginTop: 4 },
  docBtn: { marginTop: 12, borderRadius: 12, paddingVertical: 13, alignItems: 'center', backgroundColor: '#eef3fb' },
  docBtnText: { color: '#31518a', fontSize: 14, fontWeight: '600' },
  busy: { marginTop: 20 },
  rowBtns: { flexDirection: 'row', gap: 12, marginTop: 16 },
  rowBtn: { flex: 1, backgroundColor: '#fff', borderRadius: 12, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: '#cfd9ea' },
  rowBtnText: { color: '#31518a', fontSize: 15, fontWeight: '700' },
  historyBtn: { marginTop: 14, backgroundColor: '#fff', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#cfd9ea' },
  historyBtnText: { color: '#31518a', fontSize: 15, fontWeight: '700' },
  historyBtnHint: { color: '#98a2b3', fontSize: 11, marginTop: 3 },
  scrollContent: { paddingBottom: 60 },
});
