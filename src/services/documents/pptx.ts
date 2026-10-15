/**
 * PPTX 文本提取（纯函数，仅依赖 fflate）：
 * .pptx 为 ZIP + OOXML；按 ppt/slides/slideN.xml 顺序提取 <a:t> 文本节点，
 * 每页加"【第 N 页】"来源标记，便于分块后追溯页码。
 * 注意：仅提取文字；图片、图表、公式（OMML）不包含在内。
 */
import { strFromU8, unzipSync } from 'fflate';
import { finalizeExtract, type ExtractResult } from './docCommon';

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

export function pptxBytesToText(bytes: Uint8Array): ExtractResult {
  const files = unzipSync(bytes);
  const slideNames = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml$/.exec(a)?.[1] ?? 0);
      const nb = Number(/slide(\d+)\.xml$/.exec(b)?.[1] ?? 0);
      return na - nb;
    });
  const parts: string[] = [];
  for (const name of slideNames) {
    const xml = strFromU8(files[name]);
    const paragraphs = xml.split(/<a:p[\s>]/).slice(1);
    const lines: string[] = [];
    for (const seg of paragraphs) {
      const runs = [...seg.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
      const line = runs.join('').trim();
      if (line) lines.push(line);
    }
    const text = lines.join('\n');
    if (text) parts.push(`【第 ${parts.length + 1} 页】\n${text}`);
  }
  return finalizeExtract(parts.join('\n\n'), slideNames.length);
}
