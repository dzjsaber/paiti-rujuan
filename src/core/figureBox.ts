/**
 * AI 输出的图形区域 bbox → 图片像素裁剪矩形（纯函数，可离线测试）。
 * 模型给坐标的方式不稳定：实测有像素坐标、比例坐标两种，偶发 0-1000 归一化。
 * 这里做启发式识别并 clamp 到图片范围；区域过小（多半是误标）则放弃。
 * shortcut: 坐标体系靠数值范围猜测，模型完全给错时不救；配图仅作草稿，用户可在确认页重截/移除。
 */

export interface FigureRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function toCropRect(bbox: unknown, imgW: number, imgH: number, minSide = 40): FigureRect | null {
  if (!Array.isArray(bbox) || bbox.length !== 4 || imgW <= 0 || imgH <= 0) return null;
  const n = bbox.map((x) => Number(x));
  if (!n.every((x) => Number.isFinite(x))) return null;
  let [x0, y0, x1, y1] = n;
  if (x1 <= x0 || y1 <= y0) return null;
  const mx = Math.max(x0, x1);
  const my = Math.max(y0, y1);
  if (mx <= 1.2 && my <= 1.2) {
    // 比例坐标（0-1）
    x0 *= imgW;
    x1 *= imgW;
    y0 *= imgH;
    y1 *= imgH;
  } else if (mx > imgW * 1.05 || my > imgH * 1.05) {
    // 超出图片范围：按 0-1000 归一化处理
    x0 = (x0 / 1000) * imgW;
    x1 = (x1 / 1000) * imgW;
    y0 = (y0 / 1000) * imgH;
    y1 = (y1 / 1000) * imgH;
  }
  x0 = clamp(x0, 0, imgW);
  x1 = clamp(x1, 0, imgW);
  y0 = clamp(y0, 0, imgH);
  y1 = clamp(y1, 0, imgH);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < minSide || height < minSide) return null;
  return { originX: Math.round(x0), originY: Math.round(y0), width: Math.round(width), height: Math.round(height) };
}
