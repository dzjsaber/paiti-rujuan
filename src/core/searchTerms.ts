/**
 * 题目文本 → 教材检索片段（纯函数）：
 * trigram FTS 最小匹配长度为 3 字符，因此按标点切分并保留 ≥3 字的片段，
 * 过长的句子截断为前 12 字（trigram 短片段命中更准），最多取 8 个去重片段。
 */

export function buildSearchTerms(text: string, maxTerms = 8): string[] {
  const segs = text
    .split(/[\s，。、；：？！""''（）()【】《》,.;:?!\n\r\t]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of segs) {
    const t = s.length > 12 ? s.slice(0, 12) : s;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= maxTerms) break;
  }
  return out;
}
