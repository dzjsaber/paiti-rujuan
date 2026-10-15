/**
 * 文档分块（§F8）：默认 3000 字符、有限重叠；优先在题目边界切分，
 * 避免把一道题的题干、选项和答案拆开；记录字符区间用于来源追踪。
 */

export interface DocChunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
}

const QUESTION_START = /^\s*(\d{1,3})\s*[.、．)）]/;

/** 教材分块边界：Markdown 标题 / “第X章/节/讲” / 数字小节号 开头的段落 */
export const MATERIAL_BOUNDARY = /^\s*(?:#{1,6}\s|第[一二三四五六七八九十百千0-9]+[章节讲单元]|[0-9]+(?:\.[0-9]+)*\s+\S)/;

export function chunkDocument(
  text: string,
  maxLen = 3000,
  overlap = 200,
  boundaryRe: RegExp = QUESTION_START,
): DocChunk[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.trim()) return [];

  // 按空行拆段，并记录每段在原文中的起始位置
  const rawParas = normalized.split(/\n{2,}/);
  const paras: { text: string; start: number }[] = [];
  let cursor = 0;
  for (const p of rawParas) {
    if (!p.trim()) continue;
    const idx = normalized.indexOf(p, cursor);
    const start = idx < 0 ? cursor : idx;
    paras.push({ text: p, start });
    cursor = start + p.length;
  }
  if (paras.length === 0) return [];

  const chunks: DocChunk[] = [];
  let cur: { start: number; end: number } | null = null;

  const flush = () => {
    if (!cur) return;
    chunks.push({
      index: chunks.length,
      text: normalized.slice(cur.start, cur.end),
      charStart: cur.start,
      charEnd: cur.end,
    });
    cur = null;
  };

  for (const p of paras) {
    const pEnd = p.start + p.text.length;
    if (!cur) {
      cur = { start: p.start, end: pEnd };
      continue;
    }
    const wouldLen = pEnd - cur.start;
    const curLen = cur.end - cur.start;
    const isBoundary = boundaryRe.test(p.text);
    const breakAtBoundary = isBoundary && curLen >= maxLen * 0.6;
    if (wouldLen > maxLen || breakAtBoundary) {
      const prevEnd: number = cur.end;
      flush();
      // 自然边界（标题/题号）处切分：不带重叠，保证边界干净地成为新块开头；
      // 超长硬切时才带有限重叠（不超过 overlap，且不越过上一块内部）
      const withOverlap = !breakAtBoundary && overlap > 0;
      const overlapStart: number = withOverlap ? Math.max(p.start - overlap, prevEnd - overlap) : p.start;
      cur = { start: Math.min(overlapStart, p.start), end: pEnd };
      continue;
    }
    cur.end = pEnd;
  }
  flush();
  return chunks;
}
