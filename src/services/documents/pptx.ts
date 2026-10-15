/**
 * PPTX 文本提取（纯函数，仅依赖 fflate）：
 * .pptx 为 ZIP + OOXML；按 ppt/slides/slideN.xml 顺序提取 <a:t> 文本节点，
 * 每页加"【第 N 页】"来源标记，便于分块后追溯页码。
 * 注意：仅提取文字；图片、图表、公式（OMML）不包含在内。
 */
import { strFromU8, unzipSync } from 'fflate';
import { finalizeExtract, type ExtractResult, type ExtractedImage } from './docCommon';

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
  return pptxBytesToTextAndImages(bytes);
}

/** 文本 + 内嵌图片（按页提取；页内按 blip 引用顺序；emf/wmf 等 RN 不可渲染格式跳过） */
export function pptxBytesToTextAndImages(bytes: Uint8Array): ExtractResult {
  const files = unzipSync(bytes);
  const slideNames = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml$/.exec(a)?.[1] ?? 0);
      const nb = Number(/slide(\d+)\.xml$/.exec(b)?.[1] ?? 0);
      return na - nb;
    });
  const parts: string[] = [];
  const images: ExtractedImage[] = [];
  let pageNo = 0;
  for (const name of slideNames) {
    pageNo += 1;
    const xml = strFromU8(files[name]);
    const paragraphs = xml.split(/<a:p[\s>]/).slice(1);
    const lines: string[] = [];
    for (const seg of paragraphs) {
      const runs = [...seg.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
      const line = runs.join('').trim();
      if (line) lines.push(line);
    }
    const text = lines.join('\n');
    if (text) parts.push(`【第 ${pageNo} 页】\n${text}`);

    // 内嵌图片：slide xml 的 blip 引用顺序 → rels → media 文件
    const slideFile = name.split('/').pop() ?? '';
    const relsXml = files[`ppt/slides/_rels/${slideFile}.rels`] ? strFromU8(files[`ppt/slides/_rels/${slideFile}.rels`]) : '';
    const relMap = new Map<string, string>();
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const seg = m[0];
      const idM = /Id="([^"]+)"/.exec(seg);
      const tM = /Target="([^"]+)"/.exec(seg);
      if (idM && tM) relMap.set(idM[1], tM[1]);
    }
    const seen = new Set<string>();
    for (const bm of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
      const target = relMap.get(bm[1]);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const mediaPath = target.startsWith('../') ? `ppt/${target.slice(3)}` : target.replace(/^\//, '');
      const file = files[mediaPath];
      if (!file || file.length > 10 * 1024 * 1024 || file.length < 256) continue;
      const rawExt = (mediaPath.split('.').pop() ?? 'png').toLowerCase();
      if (!['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(rawExt)) continue;
      images.push({ pageNo, ext: rawExt === 'jpeg' ? 'jpg' : rawExt, data: file });
    }
  }
  return { ...finalizeExtract(parts.join('\n\n'), slideNames.length), images };
}
