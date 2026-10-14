/**
 * 交叉验证：把 M0 实测的真实模型输出（paiti-rujuan-m0/results/**／raw/*.txt）
 * 重放给 TS 版 ResponseParser + F2，检查是否与 M0 的 Python 结论一致。
 * 运行（在 paiti-rujuan 目录下）：npx tsx tests/m0-replay.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseModelText } from '../src/services/llm/ResponseParser';
import { f2Summary, f2ValidatePage } from '../src/core/validation/f2';

const root = path.resolve(process.cwd(), '..', 'paiti-rujuan-m0', 'results');
if (!fs.existsSync(root)) {
  console.error('未找到 M0 结果目录：' + root);
  process.exit(2);
}

const files: string[] = [];
for (const run of fs.readdirSync(root).sort()) {
  const rawDir = path.join(root, run, 'raw');
  if (!fs.existsSync(rawDir)) continue;
  for (const f of fs.readdirSync(rawDir).sort()) {
    files.push(path.join(rawDir, f));
  }
}

const totals = { files: 0, failed: 0, drafts: 0, passed: 0, needs_review: 0, invalid: 0 };
const rows: string[] = [];

for (const f of files) {
  totals.files += 1;
  const text = fs.readFileSync(f, 'utf8');
  const r = parseModelText(text);
  const label = path.basename(path.dirname(path.dirname(f))) + '/' + path.basename(f);
  if (!r.drafts) {
    totals.failed += 1;
    rows.push(`${label}  parse=${r.mode}  (${r.error})`);
    continue;
  }
  const results = f2ValidatePage(r.drafts);
  const s = f2Summary(results);
  totals.drafts += r.drafts.length;
  totals.passed += s.passed;
  totals.needs_review += s.needs_review;
  totals.invalid += s.invalid;
  rows.push(`${label}  mode=${r.mode}  drafts=${r.drafts.length}  passed=${s.passed} review=${s.needs_review} invalid=${s.invalid}`);
}

console.log(rows.join('\n'));
console.log(
  `\n合计：文件 ${totals.files}（解析失败 ${totals.failed}）/ 草稿 ${totals.drafts} / passed=${totals.passed} needs_review=${totals.needs_review} invalid=${totals.invalid}`,
);
