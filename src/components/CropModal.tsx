/** 手动框选局部区域（M1-D 最后兜底）：拖动绘制矩形，确认后按原图像素坐标回传。 */
import { useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { CropRect } from '../services/image';

export interface CropModalProps {
  visible: boolean;
  imageUri: string;
  imageWidth: number;
  imageHeight: number;
  onCancel: () => void;
  onConfirm: (rect: CropRect) => void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_BOX = 32;

export function CropModal({ visible, imageUri, imageWidth, imageHeight, onCancel, onConfirm }: CropModalProps) {
  const { width: winW, height: winH } = useWindowDimensions();
  const [box, setBox] = useState<Box | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const boxRef = useRef<Box | null>(null);

  const layout = useMemo(() => {
    const pad = 12;
    const topBar = 72;
    const bottomBar = 120;
    const maxW = winW - pad * 2;
    const maxH = winH - topBar - bottomBar;
    const scale = Math.min(maxW / imageWidth, maxH / imageHeight);
    const w = imageWidth * scale;
    const h = imageHeight * scale;
    return { w, h, scale, left: (winW - w) / 2, top: topBar };
  }, [winW, winH, imageWidth, imageHeight]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          const { locationX, locationY } = evt.nativeEvent;
          startRef.current = { x: locationX, y: locationY };
          const b: Box = { x: locationX, y: locationY, w: 0, h: 0 };
          boxRef.current = b;
          setBox(b);
        },
        onPanResponderMove: (evt) => {
          const start = startRef.current;
          if (!start) return;
          const { locationX, locationY } = evt.nativeEvent;
          const x = Math.max(0, Math.min(start.x, locationX));
          const y = Math.max(0, Math.min(start.y, locationY));
          const w = Math.min(layout.w, Math.max(start.x, locationX)) - x;
          const h = Math.min(layout.h, Math.max(start.y, locationY)) - y;
          const b: Box = { x, y, w, h };
          boxRef.current = b;
          setBox(b);
        },
      }),
    [layout.w, layout.h],
  );

  const confirm = () => {
    const b = boxRef.current;
    if (!b || b.w < MIN_BOX || b.h < MIN_BOX) return;
    onConfirm({
      originX: b.x / layout.scale,
      originY: b.y / layout.scale,
      width: b.w / layout.scale,
      height: b.h / layout.scale,
    });
  };

  const reset = () => {
    startRef.current = null;
    boxRef.current = null;
    setBox(null);
  };

  return (
    <Modal visible={visible} transparent onRequestClose={onCancel}>
      <View style={styles.bg}>
        <Text style={styles.tip}>拖动框选要识别的区域（例如某道题的图形区域）</Text>
        <View
          style={[styles.imageWrap, { position: 'absolute', left: layout.left, top: layout.top, width: layout.w, height: layout.h }]}
          {...panResponder.panHandlers}
        >
          <Image source={{ uri: imageUri }} style={{ width: layout.w, height: layout.h }} resizeMode="stretch" />
          {box && box.w > 0 && box.h > 0 && (
            <View
              pointerEvents="none"
              style={[styles.selBox, { left: box.x, top: box.y, width: box.w, height: box.h }]}
            />
          )}
        </View>
        <View style={styles.bar}>
          <Pressable style={styles.ghost} onPress={reset}>
            <Text style={styles.ghostText}>重新框选</Text>
          </Pressable>
          <Pressable style={styles.ghost} onPress={onCancel}>
            <Text style={styles.ghostText}>取消</Text>
          </Pressable>
          <Pressable style={styles.primary} onPress={confirm}>
            <Text style={styles.primaryText}>识别该区域</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' },
  tip: { marginTop: 36, textAlign: 'center', color: '#dbe4ff', fontSize: 14 },
  imageWrap: { backgroundColor: '#111' },
  selBox: { position: 'absolute', borderWidth: 2, borderColor: '#4da3ff', backgroundColor: 'rgba(77,163,255,0.18)' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 28, flexDirection: 'row', justifyContent: 'center', gap: 12, paddingHorizontal: 16 },
  ghost: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  ghostText: { color: '#fff', fontSize: 14 },
  primary: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 10, backgroundColor: '#1c5cd6' },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
