/** 临时调试：用真实 .ppt 验证解析器 */
import * as fs from 'node:fs';
import { pptBytesToText } from '../src/services/documents/ppt';

const file = process.argv[2];
if (!file) {
  console.log('用法: npx tsx tests/debug-ppt.ts <file.ppt>');
  process.exit(1);
}
const t0 = Date.now();
try {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const r = pptBytesToText(bytes);
  console.log(`耗时 ${Date.now() - t0}ms · 页数=${r.pageCount} · 字符数=${r.text.length}`);
  console.log('--- 前 1500 字符 ---');
  console.log(r.text.slice(0, 1500));
} catch (e) {
  console.log('解析失败:', (e as Error).message);
}
