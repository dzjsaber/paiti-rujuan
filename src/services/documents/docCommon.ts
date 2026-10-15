/** 文档提取的公共类型与后处理（纯函数，可离线测试）。 */

export interface ExtractResult {
  text: string;
  pageCount: number | null;
  warnings: string[];
  /** 内嵌图片（仅 PPT/PPTX 支持）：pageNo 为来源页码，老版 .ppt 无页关联时为 null */
  images?: ExtractedImage[];
}

export interface ExtractedImage {
  pageNo: number | null;
  ext: string;
  data: Uint8Array;
}

export const SCAN_WARN_CHARS = 100;

export function finalizeExtract(text: string, pageCount: number | null, extra: string[] = []): ExtractResult {
  const clean = text.replace(/\u0000/g, '');
  const warnings = [...extra];
  if (clean.trim().length < SCAN_WARN_CHARS) {
    warnings.push(
      '提取到的文本极少，可能是扫描版（图片型）文件。本期不支持扫描版 OCR：可以逐页截图后走"拍照识别"，或换一份文字版文件。',
    );
  }
  return { text: clean, pageCount, warnings };
}
