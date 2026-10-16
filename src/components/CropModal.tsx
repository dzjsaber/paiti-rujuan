/**
 * 手动框选局部区域（作业帮式交互）：
 * - 在图上拖动绘制选框；
 * - 松开后进入微调模式：拖动 8 个手柄调整边界、拖动框内移动整框；
 * - 点击框外任意位置重新绘制；
 * - 支持较小区域（单道小题也能识别），确认时按原图像素坐标回传。
 */
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
import { usePinchZoom } from './usePinchZoom';

export interface CropModalProps {
  visible: boolean;
  imageUri: string;
  imageWidth: number;
  imageHeight: number;
  /** 主按钮文案（默认用于识别；相册确认页裁剪时传"完成裁剪"） */
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (rect: CropRect) => void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type HandleName = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r';
const HANDLES: HandleName[] = ['tl', 'tr', 'bl', 'br', 't', 'b', 'l', 'r'];

type DragState =
  | { kind: 'draw'; startX: number; startY: number }
  | { kind: 'move'; startBox: Box; startX: number; startY: number }
  | { kind: 'handle'; handle: HandleName; startBox: Box };

const HANDLE_VISUAL = 14;
const HANDLE_HIT = 30;
const MIN_BOX = 12;
const MIN_CONFIRM = 8;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function handleCenter(b: Box, h: HandleName): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  switch (h) {
    case 'tl':
      return { x: b.x, y: b.y };
    case 'tr':
      return { x: b.x + b.w, y: b.y };
    case 'bl':
      return { x: b.x, y: b.y + b.h };
    case 'br':
      return { x: b.x + b.w, y: b.y + b.h };
    case 't':
      return { x: cx, y: b.y };
    case 'b':
      return { x: cx, y: b.y + b.h };
    case 'l':
      return { x: b.x, y: cy };
    default:
      return { x: b.x + b.w, y: cy };
  }
}

export function CropModal({
  visible,
  imageUri,
  imageWidth,
  imageHeight,
  confirmLabel = '识别该区域',
  onCancel,
  onConfirm,
}: CropModalProps) {
  const { width: winW, height: winH } = useWindowDimensions();
  const [box, setBox] = useState<Box | null>(null);
  const boxRef = useRef<Box | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const layout = useMemo(() => {
    const pad = 12;
    const topBar = 84;
    const bottomBar = 128;
    const maxW = winW - pad * 2;
    const maxH = winH - topBar - bottomBar;
    const scale = Math.min(maxW / imageWidth, maxH / imageHeight);
    const w = imageWidth * scale;
    const h = imageHeight * scale;
    return { w, h, scale, left: (winW - w) / 2, top: topBar };
  }, [winW, winH, imageWidth, imageHeight]);

  /** 双指缩放：缩放只影响显示，选框仍存"基准图片坐标" */
  const pz = usePinchZoom(layout.w, layout.h);
  const zoom = pz.zoom;

  const setBoxBoth = (b: Box | null) => {
    boxRef.current = b;
    setBox(b);
  };

  const hitHandle = (b: Box, px: number, py: number, scale = 1): HandleName | null => {
    for (const h of HANDLES) {
      const c = handleCenter(b, h);
      const reach = HANDLE_HIT / scale;
      if (Math.abs(px - c.x) <= reach && Math.abs(py - c.y) <= reach) return h;
    }
    return null;
  };

  const inside = (b: Box, px: number, py: number): boolean =>
    px >= b.x - 4 && px <= b.x + b.w + 4 && py >= b.y - 4 && py <= b.y + b.h + 4;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          if (pz.grant(evt.nativeEvent.touches)) {
            dragRef.current = null;
            return;
          }
          const { x, y } = pz.toImg(evt.nativeEvent.locationX, evt.nativeEvent.locationY);
          const b = boxRef.current;
          if (b) {
            const h = hitHandle(b, x, y, pz.zoomRef.current.scale);
            if (h) {
              dragRef.current = { kind: 'handle', handle: h, startBox: { ...b } };
              return;
            }
            if (inside(b, x, y)) {
              dragRef.current = { kind: 'move', startBox: { ...b }, startX: x, startY: y };
              return;
            }
          }
          setBoxBoth({ x, y, w: 0, h: 0 });
          dragRef.current = { kind: 'draw', startX: x, startY: y };
        },
        // 第二根手指按下（grant 只会在手势开始时触发一次）
        onPanResponderStart: (evt) => {
          if (pz.grant(evt.nativeEvent.touches)) {
            dragRef.current = null;
          }
        },
        onPanResponderMove: (evt) => {
          if (pz.move(evt.nativeEvent.touches)) return;
          const d = dragRef.current;
          if (!d) return;
          const { x, y } = pz.toImg(evt.nativeEvent.locationX, evt.nativeEvent.locationY);
          if (d.kind === 'draw') {
            const nx = clamp(Math.min(d.startX, x), 0, layout.w);
            const ny = clamp(Math.min(d.startY, y), 0, layout.h);
            const nw = clamp(Math.abs(x - d.startX), 0, layout.w - nx);
            const nh = clamp(Math.abs(y - d.startY), 0, layout.h - ny);
            setBoxBoth({ x: nx, y: ny, w: nw, h: nh });
            return;
          }
          if (d.kind === 'move') {
            const nx = clamp(d.startBox.x + (x - d.startX), 0, layout.w - d.startBox.w);
            const ny = clamp(d.startBox.y + (y - d.startY), 0, layout.h - d.startBox.h);
            setBoxBoth({ ...d.startBox, x: nx, y: ny });
            return;
          }
          // handle 微调
          const s = d.startBox;
          let x1 = s.x;
          let y1 = s.y;
          let x2 = s.x + s.w;
          let y2 = s.y + s.h;
          if (d.handle.includes('l')) x1 = clamp(x, 0, x2 - MIN_BOX);
          if (d.handle.includes('r')) x2 = clamp(x, x1 + MIN_BOX, layout.w);
          if (d.handle.includes('t')) y1 = clamp(y, 0, y2 - MIN_BOX);
          if (d.handle.includes('b')) y2 = clamp(y, y1 + MIN_BOX, layout.h);
          setBoxBoth({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
        },
        onPanResponderRelease: () => {
          pz.end([]);
          dragRef.current = null;
        },
        // 单指抬起但仍有其他手指在屏幕上（如缩放后先松一指）
        onPanResponderEnd: (evt) => {
          pz.end(evt.nativeEvent.touches);
        },
        onPanResponderTerminate: () => {
          pz.end([]);
          dragRef.current = null;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout.w, layout.h, pz.grant, pz.move, pz.end, pz.toImg],
  );

  const confirm = () => {
    const b = boxRef.current;
    if (!b || b.w < MIN_CONFIRM || b.h < MIN_CONFIRM) return;
    onConfirm({
      originX: b.x / layout.scale,
      originY: b.y / layout.scale,
      width: b.w / layout.scale,
      height: b.h / layout.scale,
    });
  };

  const canConfirm = !!box && box.w >= MIN_CONFIRM && box.h >= MIN_CONFIRM;

  return (
    <Modal visible={visible} transparent onRequestClose={onCancel}>
      <View style={styles.bg}>
        <Text style={styles.tip}>拖动框选区域；双指可缩放图片；松开后拖小方块可微调边界</Text>
        <View
          style={[
            styles.imageWrap,
            { position: 'absolute', left: layout.left, top: layout.top, width: layout.w, height: layout.h, overflow: 'hidden' },
          ]}
          {...panResponder.panHandlers}
        >
          <View
            style={{
              width: layout.w,
              height: layout.h,
              transform: [{ translateX: zoom.tx }, { translateY: zoom.ty }, { scale: zoom.scale }],
            }}
          >
            <Image source={{ uri: imageUri }} style={{ width: layout.w, height: layout.h }} resizeMode="stretch" />
            {box && (
              <>
                <View pointerEvents="none" style={[styles.selBox, { left: box.x, top: box.y, width: box.w, height: box.h }]} />
                {HANDLES.map((h) => {
                  const c = handleCenter(box, h);
                  return (
                    <View
                      key={h}
                      pointerEvents="none"
                      style={[styles.handle, { left: c.x - HANDLE_VISUAL / 2, top: c.y - HANDLE_VISUAL / 2 }]}
                    />
                  );
                })}
              </>
            )}
          </View>
        </View>
        <View style={styles.bar}>
          <Pressable style={styles.ghost} onPress={() => setBoxBoth(null)}>
            <Text style={styles.ghostText}>重选</Text>
          </Pressable>
          <Pressable style={styles.ghost} onPress={onCancel}>
            <Text style={styles.ghostText}>取消</Text>
          </Pressable>
          <Pressable style={[styles.primary, !canConfirm && styles.primaryDisabled]} onPress={confirm} disabled={!canConfirm}>
            <Text style={styles.primaryText}>{confirmLabel}</Text>
          </Pressable>
        </View>
        {!canConfirm && <Text style={styles.hint}>请先在图片上框出区域</Text>}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' },
  tip: { marginTop: 40, textAlign: 'center', color: '#dbe4ff', fontSize: 13 },
  imageWrap: { backgroundColor: '#111' },
  selBox: { position: 'absolute', borderWidth: 2, borderColor: '#4da3ff', backgroundColor: 'rgba(77,163,255,0.16)' },
  handle: {
    position: 'absolute',
    width: HANDLE_VISUAL,
    height: HANDLE_VISUAL,
    borderRadius: 3,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#4da3ff',
  },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 30, flexDirection: 'row', justifyContent: 'center', gap: 12, paddingHorizontal: 16 },
  ghost: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  ghostText: { color: '#fff', fontSize: 14 },
  primary: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 10, backgroundColor: '#1c5cd6' },
  primaryDisabled: { opacity: 0.45 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  hint: { position: 'absolute', left: 0, right: 0, bottom: 12, textAlign: 'center', color: '#f0b429', fontSize: 12 },
});
