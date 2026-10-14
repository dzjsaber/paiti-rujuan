// M1-A：文档解析候选库在 Expo + Metro 下的打包兼容性验证。
// 只验证"能被 Metro 打进 Hermes bundle 且模块导出存在"，不做真实解析
// （真实解析需要真机 + 样本文件，属 M2 范围）。
import * as mammothRaw from 'mammoth';
// M1-A 验证结论（2026-10-15，Expo SDK 57 / Hermes）：
// - pdfjs-dist 6.4.299（默认与 legacy 构建）和 4.2.67 均打包失败：内部使用
//   `await import(/*webpackIgnore: true*/ ...)` 计算表达式，hermesc 报
//   "Invalid expression encountered"。
// - 当前使用 3.11.174：可打包。但该版本受 GHSA-wgrm-67xf-hhpq 影响
//   （影响范围 <=4.1.392，CVE-2024-4367 类：解析恶意 PDF 可触发 JS 执行）。
//   M2 实现 PDF 文本提取时必须：设置 isEvalSupported: false、只调用
//   getTextContent()、不渲染、不执行 PDF 内嵌脚本；升级路径记入技术债。
// - mammoth 1.13.0（BSD-2-Clause，已获用户批准）：可打包。
import * as pdfjsRaw from 'pdfjs-dist';

const mammoth = mammothRaw as unknown as { convertToHtml?: unknown };
const pdfjs = pdfjsRaw as unknown as { getDocument?: unknown };

export function verifyDocParseLibsLoaded(): string[] {
  return [
    `mammoth.convertToHtml: ${typeof mammoth.convertToHtml === 'function' ? 'OK' : '缺失'}`,
    `pdfjs.getDocument: ${typeof pdfjs.getDocument === 'function' ? 'OK' : '缺失'}`,
  ];
}
