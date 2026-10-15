/** 临时调试：用真实 .ppt 验证解析器 */
import * as fs from 'node:fs';
import { pptBytesToText } from '../src/services/documents/ppt';
import { pptxBytesToTextAndImages } from '../src/services/documents/pptx';

const file = process.argv[2];
if (!file) {
  console.log('用法: npx tsx tests/debug-ppt.ts <file.ppt>');
  process.exit(1);
}
const t0 = Date.now();
try {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const r = file.toLowerCase().endsWith('.pptx') ? pptxBytesToTextAndImages(bytes) : pptBytesToText(bytes);
  console.log(`耗时 ${Date.now() - t0}ms · 页数=${r.pageCount} · 字符数=${r.text.length}`);
  console.log(`图片: ${r.images?.length ?? 0} 张` + (r.images?.length ? `（首张 ${r.images[0].ext} ${r.images[0].data.length} 字节 p${r.images[0].pageNo}）` : ''));
  r.images?.forEach((img, i) => console.log(`  [${i}] ${img.ext} ${img.data.length} bytes`));
  console.log('--- 前 1500 字符 ---');
  console.log(r.text.slice(0, 1500));
} catch (e) {
  console.log('解析失败:', (e as Error).message);
}
