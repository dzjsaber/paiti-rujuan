/**
 * 题目文本 → 教材检索片段（纯函数）：
 * trigram FTS 的最小匹配单位是 3 字符。早期做法把整句（截断 12 字）当"连续短语"匹配，
 * 只要教材措辞或标点与题干不同就命中不到（真机实测 8 题只中 2 题）。
 * 改为：清理标点得到连续串，滑窗取 3 字片段作为独立 OR 检索词，对措辞差异宽容。
 * 超长题干按步长采样控制数量，并保证覆盖串尾（题干末尾常是关键术语）。
 */

export function buildSearchTerms(text: string, maxTerms = 40): string[] {
  const clean = text.replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, '');
  if (clean.length < 3) return [];
  const winCount = clean.length - 2;
  const step = Math.max(1, Math.ceil(winCount / maxTerms));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < winCount; i += step) {
    const t = clean.slice(i, i + 3);
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  const tail = clean.slice(-3);
  if (!seen.has(tail)) out.push(tail);
  return out;
}

/**
 * 从命中的教材片段中截取展示窗口：从题干尾部倒着找锚（题干末尾术语最贴近考点）。
 * - 片段 ≤2×maxLen：原样返回；
 * - 锚在片段中部：围绕锚截取；
 * - 锚在头部/尾部或找不到锚：取"头 maxLen + 尾 maxLen"（答案可能在表格/列表里，
 *   实测有片段答案位于 547 字处，单窗口截取盖不到）。
 */
export function clipHitText(text: string, terms: string[], maxLen = 300): string {
  if (text.length <= maxLen * 2) return text;
  let pos = -1;
  for (let i = terms.length - 1; i >= 0; i -= 1) {
    const idx = text.indexOf(terms[i]);
    if (idx >= 0) {
      pos = idx;
      break;
    }
  }
  if (pos >= maxLen && pos <= text.length - maxLen) {
    const start = Math.max(0, pos - 40);
    return `……${text.slice(start, start + maxLen)}……`;
  }
  return `${text.slice(0, maxLen)}\n……\n${text.slice(-maxLen)}`;
}
