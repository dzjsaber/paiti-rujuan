/** 首页：题库统计 + 拍照/相册导入入口 + 设置入口。 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { SQLiteDatabase } from 'expo-sqlite';
import { DEFAULT_BANK_ID } from '../db/database';
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
}

export function HomeScreen({ db, onOpenReview, onOpenSettings }: HomeScreenProps) {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setCount(await countQuestions(db, DEFAULT_BANK_ID));
    } catch {
      setCount(null);
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
    <View style={styles.page}>
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

      {busy && <ActivityIndicator style={styles.busy} />}

      <Text style={styles.footer}>图片在本地压缩后直传智谱识别接口，不经第三方图床。</Text>
    </View>
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
  busy: { marginTop: 20 },
  footer: { marginTop: 'auto', marginBottom: 24, fontSize: 11, color: '#9aa2b1', lineHeight: 16 },
});
