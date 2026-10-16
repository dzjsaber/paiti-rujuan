/**
 * 双指缩放/平移状态与事件换算（CropModal 框选页与相册确认页共用）。
 * 用法：在自己的 PanResponder 回调里先调用 grant/move/end；
 * move 返回 true 表示事件已被缩放消费，调用方应跳过单指逻辑。
 * 缩放围绕显示区中心：屏幕 = 中心 + (图片 - 中心) * scale + (tx, ty)。
 */
import { useCallback, useRef, useState } from 'react';

export interface ZoomTransform {
  scale: number;
  tx: number;
  ty: number;
}

interface TouchPoint {
  pageX: number;
  pageY: number;
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 5;

/** 屏幕坐标（相对图片容器）→ 基准图片坐标（纯函数，便于单测） */
export function screenToImage(lx: number, ly: number, w: number, h: number, z: ZoomTransform): { x: number; y: number } {
  return { x: (lx - w / 2 - z.tx) / z.scale + w / 2, y: (ly - h / 2 - z.ty) / z.scale + h / 2 };
}

export function usePinchZoom(layoutW: number, layoutH: number) {
  const [zoom, setZoom] = useState<ZoomTransform>({ scale: 1, tx: 0, ty: 0 });
  const zoomRef = useRef(zoom);
  const pinchRef = useRef<{ d0: number; cx0: number; cy0: number; z0: ZoomTransform } | null>(null);
  const layoutRef = useRef({ w: layoutW, h: layoutH });
  layoutRef.current = { w: layoutW, h: layoutH };

  const apply = useCallback((z: ZoomTransform) => {
    zoomRef.current = z;
    setZoom(z);
  }, []);

  /** 触摸开始（grant 或新增手指）。返回 true 表示已进入/维持双指缩放 */
  const grant = useCallback((touches: readonly TouchPoint[]): boolean => {
    if (touches.length < 2) return false;
    if (pinchRef.current) return true;
    const [a, b] = touches;
    const d0 = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) || 1;
    pinchRef.current = {
      d0,
      cx0: (a.pageX + b.pageX) / 2,
      cy0: (a.pageY + b.pageY) / 2,
      z0: { ...zoomRef.current },
    };
    return true;
  }, []);

  /** 触摸移动。返回 true 表示事件已被缩放消费 */
  const move = useCallback(
    (touches: readonly TouchPoint[]): boolean => {
      if (touches.length < 2) return !!pinchRef.current; // 缩放中掉到单指：本帧吞掉，避免误触发框选
      if (!pinchRef.current) grant(touches);
      const [a, b] = touches;
      const d = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) || 1;
      const p = pinchRef.current;
      if (!p) return true;
      const { w, h } = layoutRef.current;
      const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (p.z0.scale * d) / p.d0));
      const maxTx = (w * (scale - 1)) / 2 + 30;
      const maxTy = (h * (scale - 1)) / 2 + 30;
      const clamp = (v: number, m: number) => Math.min(m, Math.max(-m, v));
      apply({
        scale,
        tx: scale === 1 ? 0 : clamp(p.z0.tx + ((a.pageX + b.pageX) / 2 - p.cx0), maxTx),
        ty: scale === 1 ? 0 : clamp(p.z0.ty + ((a.pageY + b.pageY) / 2 - p.cy0), maxTy),
      });
      return true;
    },
    [apply, grant],
  );

  /** 手指抬起；不足两指时结束缩放 */
  const end = useCallback((touches: readonly TouchPoint[]): void => {
    if (pinchRef.current && touches.length < 2) pinchRef.current = null;
  }, []);

  const reset = useCallback(() => apply({ scale: 1, tx: 0, ty: 0 }), [apply]);

  const toImg = useCallback((lx: number, ly: number): { x: number; y: number } => {
    const { w, h } = layoutRef.current;
    return screenToImage(lx, ly, w, h, zoomRef.current);
  }, []);

  return { zoom, zoomRef, grant, move, end, reset, toImg };
}
