/**
 * 本地文档文本提取（§F8）：全部在本地完成，不发送任何网络请求。
 * - TXT/MD：直接读取；
 * - DOCX：mammoth（仅文本；内嵌图片一期不识别，明确提示）；
 * - PDF：pdfjs-dist 3.x（运行于 Hermes，需真机验证；失败时给出清晰错误与替代路径）。
 * 扫描版检测：提取文本 < 100 字符时给出明确警告（不伪装支持 OCR）。
 */
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as mammothRaw from 'mammoth';
import * as pdfjsRaw from 'pdfjs-dist';

export interface ExtractResult {
  text: string;
  pageCount: number | null;
  warnings: string[];
}

const SCAN_WARN_CHARS = 100;

/**
 * 文件读取统一走 expo-file-system 的 legacy API：
 * Android 上从其他应用（微信/文件管理等）选择的文件通常是 content:// 地址，
 * 新版 File API 会报 "Missing 'READ' permission"；
 * legacy readAsStringAsync 通过系统 ContentResolver 读取，兼容 content:// 与 file://。
 */
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = B64_CHARS.indexOf(clean[i] ?? 'A');
    const c2 = B64_CHARS.indexOf(clean[i + 1] ?? 'A');
    const c3 = clean[i + 2] ? B64_CHARS.indexOf(clean[i + 2]) : -1;
    const c4 = clean[i + 3] ? B64_CHARS.indexOf(clean[i + 3]) : -1;
    out[p++] = (c1 << 2) | (c2 >> 4);
    if (c3 >= 0) out[p++] = ((c2 & 15) << 4) | (c3 >> 2);
    if (c4 >= 0) out[p++] = ((c3 & 3) << 6) | c4;
  }
  return out.subarray(0, p);
}

async function readBytes(uri: string): Promise<Uint8Array> {
  const local = await materialize(uri, 'bin');
  const b64 = await FileSystemLegacy.readAsStringAsync(local, { encoding: FileSystemLegacy.EncodingType.Base64 });
  return base64ToBytes(b64);
}

async function readTextFile(uri: string): Promise<string> {
  const local = await materialize(uri, 'txt');
  return FileSystemLegacy.readAsStringAsync(local, { encoding: FileSystemLegacy.EncodingType.UTF8 });
}

/**
 * 把所选文件复制到应用自有缓存目录后再读取。
 * 背景（真机实测）：Android 上 DocumentPicker 返回的缓存路径在不同来源
 * （微信/文件管理等 provider）下可能不可读（java.io.IOException: isn't readable）；
 * 由应用自己经系统 ContentResolver 复制一份，可稳定读取。
 */
async function materialize(uri: string, ext: string): Promise<string> {
  const cacheDir = FileSystemLegacy.cacheDirectory;
  if (!cacheDir) return uri;
  const dest = `${cacheDir}imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try {
    await FileSystemLegacy.copyAsync({ from: uri, to: dest });
  } catch (e) {
    throw new Error(
      '无法读取所选文件（来源位置不可访问）。可以先把文件保存到手机的"文件"应用或下载目录后再试。原始错误：' +
        String((e as Error)?.message ?? e),
    );
  }
  return dest;
}

const mammoth = mammothRaw as unknown as {
  extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{
    value: string;
    messages: { type: string; message: string }[];
  }>;
};

const pdfjs = pdfjsRaw as unknown as {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (opts: Record<string, unknown>) => { promise: Promise<unknown> };
};

interface PdfPage {
  getTextContent: () => Promise<{ items: { str?: string }[] }>;
}
interface PdfDocument {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}

function finalize(text: string, pageCount: number | null, extra: string[] = []): ExtractResult {
  const clean = text.replace(/\u0000/g, '');
  const warnings = [...extra];
  if (clean.trim().length < SCAN_WARN_CHARS) {
    warnings.push(
      '提取到的文本极少，可能是扫描版（图片型）文件。本期不支持扫描版 OCR：可以逐页截图后走"拍照识别"，或换一份文字版文件。',
    );
  }
  return { text: clean, pageCount, warnings };
}

export async function extractTxtLike(uri: string): Promise<ExtractResult> {
  const text = await readTextFile(uri);
  return finalize(text, null);
}

export async function extractDocx(uri: string): Promise<ExtractResult> {
  const bytes = await readBytes(uri);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const result = await mammoth.extractRawText({ arrayBuffer: ab });
  const warnings: string[] = [];
  if (result.messages?.some((m) => /image/i.test(m.message ?? ''))) {
    warnings.push('文档包含图片内容：本期仅导入文本，内嵌图片不支持识别。');
  }
  return finalize(result.value ?? '', null, warnings);
}

export async function extractPdf(uri: string): Promise<ExtractResult> {
  const bytes = await readBytes(uri);
  // React Native 无 Web Worker：让 pdf.js 回退为主线程（fake worker）解析
  pdfjs.GlobalWorkerOptions.workerSrc = '';
  const doc = (await pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    disableAutoFetch: true,
  }).promise) as PdfDocument;

  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((it) => (typeof it.str === 'string' ? it.str : ''))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (line) parts.push(line);
  }
  return finalize(parts.join('\n\n'), doc.numPages);
}

export async function extractDocument(uri: string, name: string): Promise<ExtractResult> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return extractPdf(uri);
  if (lower.endsWith('.docx')) return extractDocx(uri);
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return extractTxtLike(uri);
  throw new Error(`暂不支持的文件类型：${name}（支持 PDF / DOCX / TXT / MD）`);
}
