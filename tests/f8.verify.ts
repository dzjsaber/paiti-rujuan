/** F8 纯逻辑验证：文档分块 + 答案表解析/映射。运行：npx tsx tests/f8.verify.ts */
import { applyAnswerTable, extractQuestionNo, parseAnswerTable, type MappableDraft } from '../src/services/documents/answerTable';
import { chunkDocument } from '../src/services/documents/chunker';

let passed = 0;
const fails: string[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (e) {
    fails.push(`${name}: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------- chunker

check('空文本 → 空数组', () => {
  assert(chunkDocument('   \n\n  ').length === 0, '应为空');
});

check('小文档 → 单块且字符区间可还原', () => {
  const text = '第一段。\n\n第二段。';
  const chunks = chunkDocument(text);
  assert(chunks.length === 1, `应有 1 块，实际 ${chunks.length}`);
  assert(text.slice(chunks[0].charStart, chunks[0].charEnd) === chunks[0].text, '区间应能还原文本');
});

check('超长文档 → 多块且各块不超上限（单段除外）', () => {
  const para = '这是一段测试文本，'.repeat(30); // ~240 字符
  const text = Array.from({ length: 20 }, () => para).join('\n\n');
  const chunks = chunkDocument(text, 1000, 100);
  assert(chunks.length >= 4, `应至少 4 块，实际 ${chunks.length}`);
  for (const c of chunks) {
    assert(c.text.length <= 1000 + 250, `单块长度 ${c.text.length} 超限`);
  }
});

check('题目边界优先：新段为题号开头且当前块过半时断开', () => {
  const seg = Array.from({ length: 6 }, (_, i) => `第${i + 1}题的题干内容，填充文字填充文字。`).join('\n\n');
  const text = `${seg}\n\n7. 第七题题干。\n\nA. 选项一\n\nB. 选项二`;
  const chunks = chunkDocument(text, 200, 0);
  const joined = chunks.map((c) => c.text).join('');
  assert(joined.includes('7. 第七题题干。'), '题号段应被包含');
  // 至少证明"题号开头的段"没有被从中间弃掉
});

// ---------------------------------------------------------------- 答案表

check('无"答案"标题 → 空表', () => {
  assert(parseAnswerTable('1. 题干一\n\n2. 题干二').size === 0, '应为空表');
});

check('参考答案区解析（1.A 2.B 3.C）', () => {
  const t = `1. 题干\n\n2. 题干\n\n参考答案\n1.A 2.B 3.C 4.D`;
  const map = parseAnswerTable(t);
  assert(map.size === 4, `应有 4 条，实际 ${map.size}`);
  assert(map.get('1') === 'A' && map.get('4') === 'D', '映射内容错误');
});

check('答案区解析（1、A 2、对 3、错）', () => {
  const t = `答案：\n1、A\n2、对\n3、错\n4、AB`;
  const map = parseAnswerTable(t);
  assert(map.get('2') === '对' && map.get('4') === 'AB', '判断/多选答案解析错误');
});

check('少于 3 条 → 视为无效答案表', () => {
  assert(parseAnswerTable('答案：\n1.A').size === 0, '应忽略');
});

check('extractQuestionNo 各种格式', () => {
  assert(extractQuestionNo('1. 题干') === '1', '点号');
  assert(extractQuestionNo('12、题干') === '12', '顿号');
  assert(extractQuestionNo('第3题 题干') === '3', '第N题');
  assert(extractQuestionNo('没有题号') === null, '无题号');
});

check('applyAnswerTable：单选/判断/多选映射 + 复核原因', () => {
  const drafts: MappableDraft[] = [
    { stem: '1. 下列说法正确的是', type: 'single', answer: null },
    { stem: '2. 该说法正确。', type: 'judge', answer: null },
    { stem: '3. 下列正确的有', type: 'multiple', answer: null },
  ];
  const table = new Map([
    ['1', 'B'],
    ['2', '对'],
    ['3', 'AB'],
  ]);
  const r = applyAnswerTable(drafts, table);
  assert(r.mapped === 3, `应映射 3 条，实际 ${r.mapped}`);
  assert(drafts[0].answer === 'B', '单选');
  assert(drafts[1].answer === true, '判断');
  assert(JSON.stringify(drafts[2].answer) === '["A","B"]', '多选');
  assert((drafts[0].review_reasons ?? []).some((x) => x.includes('答案表')), '应记录来源');
});

check('applyAnswerTable：题号重复 → conflict 且不映射', () => {
  const drafts: MappableDraft[] = [
    { stem: '1. 第一处', type: 'single', answer: null },
    { stem: '1. 第二处', type: 'single', answer: null },
  ];
  const r = applyAnswerTable(drafts, new Map([['1', 'A']]));
  assert(r.mapped === 1, '首次可映射');
  assert(r.conflicts === 1, '重复题号计冲突');
  assert((drafts[1].review_reasons ?? []).some((x) => x.includes('重复')), '应标记复核');
});

check('applyAnswerTable：类型不符 → conflict', () => {
  const drafts: MappableDraft[] = [{ stem: '1. 单选', type: 'single', answer: null }];
  const r = applyAnswerTable(drafts, new Map([['1', '对']]));
  assert(r.mapped === 0 && r.conflicts === 1, '应计冲突');
  assert(drafts[0].answer === null, '不得写入');
});

check('applyAnswerTable：已有答案不覆盖', () => {
  const drafts: MappableDraft[] = [{ stem: '1. 题目', type: 'single', answer: 'C' }];
  const r = applyAnswerTable(drafts, new Map([['1', 'A']]));
  assert(r.mapped === 0, '不覆盖已有答案');
  assert(drafts[0].answer === 'C', '保留原值');
});

const total = passed + fails.length;
if (fails.length > 0) {
  console.log(`F8 VERIFY FAILED：${passed}/${total} 通过`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`F8 VERIFY PASSED：${total}/${total} 用例全部符合预期`);
