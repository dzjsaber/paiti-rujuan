/**
 * 双指缩放/平移状态（CropModal 与相册确认页共用，由 react-native-gesture-handler 驱动）。
 * 显示变换：屏幕 = 中心 + (图片 - 中心) * scale + (tx, ty)。
 * 用法：
 *   pinch.onBegin(() => pz.begin())            // 记录手势起点
 *   pinch.onUpdate(e => pz.updatePinch(e.scale, e.focalX, e.focalY))
 *   pan.onBegin(() => pz.begin()); pan.onUpdate(e => pz.updatePan(e.translationX, e.translationY))
 */
import { useCallback, useRef, useState } from 'react';

export interface ZoomTransform {
  scale: number;
  tx: number;
  ty: number;
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const SLACK = 30;

/** 屏幕坐标（相对图片容器）→ 基准图片坐标（纯函数，便于单测） */
export function screenToImage(lx: number, ly: number, w: number, h: number, z: ZoomTransform): { x: number; y: number } {
  return { x: (lx - w / 2 - z.tx) / z.scale + w / 2, y: (ly - h / 2 - z.ty) / z.scale + h / 2 };
}

/** 围绕焦点缩放：焦点处的图片内容在屏幕上保持不动（纯函数，便于单测） */
export function focalZoom(
  base: ZoomTransform,
  factor: number,
  fx: number,
  fy: number,
  w: number,
  h: number,
): ZoomTransform {
  const cx = w / 2;
  const cy = h / 2;
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, base.scale * factor));
  if (scale === 1) return { scale: 1, tx: 0, ty: 0 };
  const r = scale / base.scale;
  const maxTx = (w * (scale - 1)) / 2 + SLACK;
  const maxTy = (h * (scale - 1)) / 2 + SLACK;
  const tx = Math.min(maxTx, Math.max(-maxTx, fx - cx - r * (fx - cx - base.tx)));
  const ty = Math.min(maxTy, Math.max(-maxTy, fy - cy - r * (fy - cy - base.ty)));
  return { scale, tx, ty };
}

export function usePinchZoom(layoutW: number, layoutH: number) {
  const [zoom, setZoom] = useState<ZoomTransform>({ scale: 1, tx: 0, ty: 0 });
  const zoomRef = useRef(zoom);
  /** 手势开始时的基准值（GH 的 scale / translation 都相对手势起点） */
  const baseRef = useRef<ZoomTransform | null>(null);
  const layoutRef = useRef({ w: layoutW, h: layoutH });
  layoutRef.current = { w: layoutW, h: layoutH };

  const apply = useCallback((z: ZoomTransform) => {
    zoomRef.current = z;
    setZoom(z);
  }, []);

  const begin = useCallback(() => {
    baseRef.current = { ...zoomRef.current };
  }, []);

  const updatePinch = useCallback(
    (factor: number, focalX: number, focalY: number) => {
      const base = baseRef.current ?? zoomRef.current;
      const { w, h } = layoutRef.current;
      apply(focalZoom(base, factor, focalX, focalY, w, h));
    },
    [apply],
  );

  const updatePan = useCallback(
    (dx: number, dy: number) => {
      const base = baseRef.current ?? zoomRef.current;
      const { w, h } = layoutRef.current;
      const maxTx = (w * (base.scale - 1)) / 2 + SLACK;
      const maxTy = (h * (base.scale - 1)) / 2 + SLACK;
      const clamp = (v: number, m: number) => Math.min(m, Math.max(-m, v));
      apply({ scale: base.scale, tx: clamp(base.tx + dx, maxTx), ty: clamp(base.ty + dy, maxTy) });
    },
    [apply],
  );

  const reset = useCallback(() => apply({ scale: 1, tx: 0, ty: 0 }), [apply]);

  const toImg = useCallback((lx: number, ly: number): { x: number; y: number } => {
    const { w, h } = layoutRef.current;
    return screenToImage(lx, ly, w, h, zoomRef.current);
  }, []);

  return { zoom, zoomRef, begin, updatePinch, updatePan, reset, toImg };
}
