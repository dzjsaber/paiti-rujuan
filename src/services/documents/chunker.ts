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

export function chunkDocument(text: string, maxLen = 3000, overlap = 200): DocChunk[] {
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
    const isQuestionStart = QUESTION_START.test(p.text);
    if (wouldLen > maxLen || (isQuestionStart && curLen >= maxLen * 0.6)) {
      const prevEnd: number = cur.end;
      flush();
      // 有限重叠：新块起点回退不超过 overlap，且不越过上一块内部
      const overlapStart: number = overlap > 0 ? Math.max(p.start - overlap, prevEnd - overlap) : p.start;
      cur = { start: Math.min(overlapStart, p.start), end: pEnd };
      continue;
    }
    cur.end = pEnd;
  }
  flush();
  return chunks;
}
