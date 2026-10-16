/** 首页：题库统计 + 拍照/相册导入入口 + 设置入口。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { SQLiteDatabase } from 'expo-sqlite';
import { CropModal } from '../components/CropModal';
import { usePinchZoom } from '../components/usePinchZoom';
import { cropImage, type CropRect } from '../services/image';
import { countWrongBook } from '../db/repo_practice';
import { countAllQuestions } from '../db/repo_questions';

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
  /** 相册选图后先预览确认，再进入识别（避免点错图直接开跑） */
  const [preview, setPreview] = useState<ReviewParams | null>(null);
  /** 裁剪：进入框选裁剪（CropModal）；originalPreview 用于还原 */
  const [cropping, setCropping] = useState(false);
  const [originalPreview, setOriginalPreview] = useState<ReviewParams | null>(null);

  // 预览区的图片显示区（固定容器，contain 显示；双指缩放围绕容器中心）
  const win = useWindowDimensions();
  const previewW = Math.max(200, win.width - 40);
  const previewH = Math.max(240, win.height - 330);
  const pz = usePinchZoom(previewW, previewH);

  const previewPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          pz.grant(evt.nativeEvent.touches);
        },
        onPanResponderStart: (evt) => {
          pz.grant(evt.nativeEvent.touches);
        },
        onPanResponderMove: (evt) => {
          pz.move(evt.nativeEvent.touches);
        },
        onPanResponderEnd: (evt) => {
          pz.end(evt.nativeEvent.touches);
        },
        onPanResponderRelease: () => {
          pz.end([]);
        },
        onPanResponderTerminate: () => {
          pz.end([]);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pz.grant, pz.move, pz.end],
  );

  const applyCrop = useCallback(
    (rect: CropRect) => {
      if (!preview) return;
      void (async () => {
        try {
          const cropped = await cropImage(preview.imagePath, rect);
          setOriginalPreview((o) => o ?? preview);
          setPreview({ ...preview, imagePath: cropped.uri, imageWidth: cropped.width, imageHeight: cropped.height });
          pz.reset();
          setCropping(false);
        } catch (e) {
          Alert.alert('裁剪失败', String((e as Error)?.message ?? e));
        }
      })();
    },
    [preview, pz],
  );

  const refresh = useCallback(async () => {
    try {
      setCount(await countAllQuestions(db));
    } catch {
      setCount(null);
    }
    try {
      setWrongCount(await countWrongBook(db));
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
      setPreview({
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
  }, []);

  if (preview) {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable
            onPress={() => {
              setPreview(null);
              setOriginalPreview(null);
            }}
            hitSlop={8}
          >
            <Text style={styles.back}>← 返回</Text>
          </Pressable>
          <Text style={styles.title}>确认图片</Text>
          <View style={styles.spacer} />
        </View>
        <View
          style={[styles.previewStage, { width: previewW, height: previewH }]}
          {...previewPan.panHandlers}
        >
          <View
            style={{
              width: previewW,
              height: previewH,
              transform: [{ translateX: pz.zoom.tx }, { translateY: pz.zoom.ty }, { scale: pz.zoom.scale }],
            }}
          >
            <Image source={{ uri: preview.imagePath }} style={{ width: previewW, height: previewH }} resizeMode="contain" />
          </View>
        </View>
        <Text style={styles.previewHint}>
          双指可缩放查看；确认是这张图后再开始识别{originalPreview ? '（识别裁剪后的图片）' : ''}
        </Text>
        {originalPreview && (
          <Pressable
            hitSlop={6}
            onPress={() => {
              setPreview(originalPreview);
              setOriginalPreview(null);
              pz.reset();
            }}
          >
            <Text style={styles.previewRestore}>还原原图</Text>
          </Pressable>
        )}
        <View style={styles.previewBtns}>
          <Pressable
            style={styles.previewGhost}
            onPress={() => {
              setPreview(null);
              setOriginalPreview(null);
              pz.reset();
            }}
          >
            <Text style={styles.previewGhostText}>重选</Text>
          </Pressable>
          <Pressable style={styles.previewGhost} onPress={() => setCropping(true)}>
            <Text style={styles.previewGhostText}>裁剪</Text>
          </Pressable>
          <Pressable style={styles.previewPrimary} onPress={() => onOpenReview(preview)}>
            <Text style={styles.previewPrimaryText}>开始识别</Text>
          </Pressable>
        </View>
        <CropModal
          visible={cropping}
          imageUri={preview.imagePath}
          imageWidth={preview.imageWidth ?? 1080}
          imageHeight={preview.imageHeight ?? 1440}
          confirmLabel="完成裁剪"
          onCancel={() => setCropping(false)}
          onConfirm={applyCrop}
        />
      </View>
    );
  }

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
        <Text style={styles.statLabel}>题目总数（全部题库）</Text>
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
  back: { fontSize: 15, color: '#1c5cd6' },
  spacer: { width: 52 },
  previewStage: { marginTop: 12, alignSelf: 'center', borderRadius: 12, overflow: 'hidden', backgroundColor: '#eef1f6' },
  previewHint: { marginTop: 10, fontSize: 12, color: '#8a94a6', textAlign: 'center' },
  previewRestore: { marginTop: 6, fontSize: 13, color: '#1c5cd6', textAlign: 'center' },
  previewBtns: { flexDirection: 'row', gap: 12, marginTop: 14, paddingBottom: 40 },
  previewGhost: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cfd9ea',
    backgroundColor: '#fff',
    alignItems: 'center',
    paddingVertical: 14,
  },
  previewGhostText: { color: '#31518a', fontSize: 15 },
  previewPrimary: { flex: 1, borderRadius: 12, backgroundColor: '#1c5cd6', alignItems: 'center', paddingVertical: 14 },
  previewPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
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
