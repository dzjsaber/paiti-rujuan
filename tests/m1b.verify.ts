/**
 * M1-B 验证脚本：ResponseParser + F2 + 归一化 + 错误码 + 去重。
 * 运行：npx tsx tests/m1b.verify.ts
 * 用例覆盖 M0 实测踩过的所有坑（围栏、裸换行、LaTeX 反斜杠、嵌套片段陷阱、think 标签）。
 */
import assert from 'node:assert/strict';
import { parseModelText } from '../src/services/llm/ResponseParser';
import { f2ValidatePage, f2ValidateQuestion } from '../src/core/validation/f2';
import { normalizeAnswer } from '../src/core/validation/normalize';
import { classifyApiError } from '../src/services/llm/errors';
import { stemHash } from '../src/core/dedupe';

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

const OK_SINGLE =
  '{"type":"single","stem":"下列关于函数的说法正确的是","options":[{"id":"A","text":"选项一"},{"id":"B","text":"选项二"}],"answer":"A","confidence":0.9,"review_reasons":[],"visual_features":[]}';

// ---------------------------------------------------------------- ResponseParser

check('parse strict', () => {
  const r = parseModelText(`[${OK_SINGLE}]`);
  assert.equal(r.mode, 'strict');
  assert.equal(r.drafts?.length, 1);
});

check('parse fenced', () => {
  const r = parseModelText('```json\n[' + OK_SINGLE + ']\n```');
  assert.equal(r.mode, 'fenced');
  assert.equal(r.drafts?.length, 1);
});

check('parse prefix text', () => {
  const r = parseModelText(`好的，结果如下：\n[${OK_SINGLE}]\n以上。`);
  assert.equal(r.mode, 'extracted');
});

check('parse truncated → failed', () => {
  const r = parseModelText('[{"type":"single","stem":"题目');
  assert.equal(r.mode, 'failed');
  assert.equal(r.drafts, null);
});

check('parse not array → failed', () => {
  const r = parseModelText('{"a":1}');
  assert.equal(r.mode, 'failed');
});

check('nested fragment trap → failed', () => {
  const r = parseModelText('[{"type":"single","stem":"题目文本足够长","options":["A","B"]}, oops]');
  assert.equal(r.mode, 'failed');
  assert.equal(r.drafts, null);
});

check('fenced with literal newline → fenced_repaired', () => {
  const body =
    '```json\n[{"type":"single","stem":"第一行\n第二行公式","options":' +
    '[{"id":"A","text":"甲"},{"id":"B","text":"乙"}],"answer":"A",' +
    '"confidence":0.9,"review_reasons":[],"visual_features":[]}]\n```';
  const r = parseModelText(body);
  assert.equal(r.mode, 'fenced_repaired');
  assert.equal(r.drafts?.length, 1);
  const stem = (r.drafts?.[0] as Record<string, unknown>).stem as string;
  assert.ok(stem.includes('第一行') && stem.includes('第二行'));
});

check('latex backslash repair', () => {
  const body =
    '```json\n[{"type":"single","stem":"已知 \\( y = x \\ln \\left( e + \\frac{1}{x-1} \\right) \\)","options":' +
    '[{"id":"A","text":"甲"},{"id":"B","text":"乙"}],"answer":"A",' +
    '"confidence":0.9,"review_reasons":[],"visual_features":[]}]\n```';
  const r = parseModelText(body);
  assert.equal(r.mode, 'fenced_repaired');
  const stem = (r.drafts?.[0] as Record<string, unknown>).stem as string;
  assert.ok(stem.includes('\\frac'), 'stem 应保留字面 \\frac');
  assert.ok(!stem.includes('\u000c'), 'stem 不得包含被误解的换页符');
});

check('think tag stripped', () => {
  const r = parseModelText('<think>先读图再排版</think>\n```json\n[' + OK_SINGLE + ']\n```');
  assert.equal(r.mode, 'fenced');
});

// ---------------------------------------------------------------- F2 校验

check('F2 多选压字符串 → invalid（严格模式）', () => {
  const q = {
    type: 'multiple',
    stem: '下列说法正确的有',
    options: [
      { id: 'A', text: '甲' },
      { id: 'B', text: '乙' },
      { id: 'C', text: '丙' },
    ],
    answer: 'AC',
    confidence: 0.8,
    review_reasons: [],
    visual_features: [],
  };
  assert.equal(f2ValidateQuestion(q).status, 'invalid');
});

check('F2 多选数组 → passed', () => {
  const q = {
    type: 'multiple',
    stem: '下列说法正确的有',
    options: [
      { id: 'A', text: '甲' },
      { id: 'B', text: '乙' },
      { id: 'C', text: '丙' },
    ],
    answer: ['A', 'C'],
    confidence: 0.8,
    review_reasons: [],
    visual_features: [],
  };
  assert.equal(f2ValidateQuestion(q).status, 'passed');
});

check('F2 判断题允许空选项 → passed', () => {
  const q = { type: 'judge', stem: '该说法是否正确？', options: [], answer: true, confidence: 0.9, review_reasons: [], visual_features: [] };
  assert.equal(f2ValidateQuestion(q).status, 'passed');
});

check('F2 枚举外类型（解答/填空/操作）→ invalid', () => {
  for (const t of ['解答', 'fill_in_the_blank', 'operation']) {
    const q = { type: t, stem: '这是一道题目的题干', options: [], answer: null, confidence: 0.9 };
    assert.equal(f2ValidateQuestion(q).status, 'invalid');
  }
});

check('F2 答案越界 → invalid', () => {
  const q = {
    type: 'single',
    stem: '下列说法正确的是',
    options: [
      { id: 'A', text: '甲' },
      { id: 'B', text: '乙' },
    ],
    answer: 'D',
    confidence: 0.9,
  };
  assert.equal(f2ValidateQuestion(q).status, 'invalid');
});

check('F2 低置信度 → needs_review', () => {
  const q = {
    type: 'single',
    stem: '下列关于函数的说法正确的是',
    options: [
      { id: 'A', text: '甲' },
      { id: 'B', text: '乙' },
    ],
    answer: 'A',
    confidence: 0.5,
  };
  assert.equal(f2ValidateQuestion(q).status, 'needs_review');
});

check('F2 答案缺失 → needs_review', () => {
  const q = {
    type: 'single',
    stem: '下列关于函数的说法正确的是',
    options: [
      { id: 'A', text: '甲' },
      { id: 'B', text: '乙' },
    ],
    answer: null,
    confidence: 0.9,
  };
  const r = f2ValidateQuestion(q);
  assert.equal(r.status, 'needs_review');
  assert.ok(r.issues.some((i) => i.rule === 'V8'));
});

check('F2 空题干 → invalid', () => {
  const q = {
    type: 'single',
    stem: '',
    options: [
      { id: 'A', text: '甲' },
      { id: 'B', text: '乙' },
    ],
    answer: 'A',
    confidence: 0.9,
  };
  assert.equal(f2ValidateQuestion(q).status, 'invalid');
});

check('F2 题干过短 → needs_review', () => {
  const q = {
    type: 'single',
    stem: 'abc',
    options: [
      { id: 'A', text: '甲' },
      { id: 'B', text: '乙' },
    ],
    answer: 'A',
    confidence: 0.9,
  };
  assert.equal(f2ValidateQuestion(q).status, 'needs_review');
});

check('F2 选项 id 重复 → invalid', () => {
  const q = {
    type: 'single',
    stem: '下列关于函数的说法正确的是',
    options: [
      { id: 'A', text: '甲' },
      { id: 'A', text: '乙' },
    ],
    answer: 'A',
    confidence: 0.9,
  };
  assert.equal(f2ValidateQuestion(q).status, 'invalid');
});

check('F2 图形题占位选项（全部"如图X所示"）→ needs_review 且原因可读', () => {
  const q = {
    type: 'single',
    stem: '下列图形中，正确表示函数关系的是（　）',
    options: [
      { id: 'A', text: '如图A所示' },
      { id: 'B', text: '如图B所示' },
      { id: 'C', text: '如图C所示' },
      { id: 'D', text: '如图D所示' },
    ],
    answer: 'B',
    confidence: 0.9,
  };
  const r = f2ValidateQuestion(q);
  assert.equal(r.status, 'needs_review');
  assert.ok(r.issues.some((i) => i.message.includes('图形')), '应给出图形选项提示');
});

check('F2 选项文本重复 → needs_review', () => {
  const q = {
    type: 'single',
    stem: '下列关于函数的说法正确的是',
    options: [
      { id: 'A', text: '甲' },
      { id: 'B', text: '甲' },
    ],
    answer: 'A',
    confidence: 0.9,
  };
  const r = f2ValidateQuestion(q);
  assert.equal(r.status, 'needs_review');
  assert.ok(r.issues.some((i) => i.message.includes('重复')), '应给出重复选项提示');
});

check('F2 页内重复题干 → 第二题 needs_review', () => {
  const q1 = JSON.parse(OK_SINGLE) as unknown;
  const q2 = JSON.parse(OK_SINGLE) as unknown;
  const rs = f2ValidatePage([q1, q2]);
  assert.equal(rs[0].status, 'passed');
  assert.equal(rs[1].status, 'needs_review');
  assert.ok(rs[1].issues.some((i) => i.rule === 'V5'));
});

check('F2 normalize 多选字符串 → 修复后 needs_review', () => {
  const q = {
    type: 'multiple',
    stem: '下列说法正确的有',
    options: [
      { id: 'A', text: '甲' },
      { id: 'B', text: '乙' },
      { id: 'C', text: '丙' },
    ],
    answer: 'AC',
    confidence: 0.8,
  };
  const r = f2ValidateQuestion(q, { normalize: true });
  assert.equal(r.status, 'needs_review');
  assert.ok(r.issues.some((i) => i.message.includes('多选答案由字符串拆分')));
});

// ---------------------------------------------------------------- 归一化

check('normalize 判断题「对」→ true', () => {
  const r = normalizeAnswer('judge', '对', []);
  assert.equal(r.answer, true);
  assert.ok(r.reasons.length > 0);
});

check('normalize 单选「a」→「A」', () => {
  const r = normalizeAnswer('single', 'a', ['A', 'B']);
  assert.equal(r.answer, 'A');
});

check('normalize 多选去重', () => {
  const r = normalizeAnswer('multiple', ['A', 'A', 'C'], ['A', 'B', 'C']);
  assert.deepEqual(r.answer, ['A', 'C']);
});

// ---------------------------------------------------------------- 错误码

check('errors 1302 可重试 / 1301 不可重试 / 网络可重试', () => {
  assert.equal(classifyApiError('1302', 429).retryable, true);
  assert.equal(classifyApiError('1305', 429).retryable, true);
  assert.equal(classifyApiError('1301', 400).retryable, false);
  assert.equal(classifyApiError('1211', 400).retryable, false);
  assert.equal(classifyApiError(null, null).retryable, true);
  assert.equal(classifyApiError(null, 503).retryable, true);
  assert.equal(classifyApiError('1113', 429).retryable, false);
});

// ---------------------------------------------------------------- 去重

check('dedupe 标点/空白差异 → 同 hash', () => {
  const a = stemHash('下列关于函数的说法，正确的是（）');
  const b = stemHash('下列关于函数的说法 正确的是  ()');
  assert.equal(a, b);
  const c = stemHash('下列关于导数的说法正确的是');
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------- 汇总

const total = passed + failures.length;
if (failures.length > 0) {
  console.log(`M1-B VERIFY FAILED：${passed}/${total} 通过`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`M1-B VERIFY PASSED：${total}/${total} 用例全部符合预期`);
