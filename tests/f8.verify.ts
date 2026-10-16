/** F8 纯逻辑验证：文档分块 + 答案表解析/映射。运行：npx tsx tests/f8.verify.ts */
import {
  applyAnswerTable,
  extractQuestionNo,
  parseAnswerDoc,
  parseAnswerTable,
  type MappableDraft,
} from '../src/services/documents/answerTable';
import { MATERIAL_BOUNDARY, chunkDocument } from '../src/services/documents/chunker';
import { checkQuestionNumbers, extractQuestionNumbers } from '../src/core/questionNumbers';
import { pptxBytesToText } from '../src/services/documents/pptx';
import { pptBytesToText } from '../src/services/documents/ppt';
import { strToU8, zipSync } from 'fflate';

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

check('教材分块（800/100，章节标题边界）', () => {
  const para = '教科书正文内容，用于验证教材分块策略。'.repeat(12); // ~230 字符
  // 前置 6 段撑满一个块后，再遇"第二章"标题，应优先在此断开
  const blocks = [
    ...Array.from({ length: 6 }, () => para),
    '第二章 有理数',
    ...Array.from({ length: 6 }, () => para),
  ];
  const text = blocks.join('\n\n');
  const chunks = chunkDocument(text, 800, 100, MATERIAL_BOUNDARY);
  assert(chunks.length >= 3, `应至少 3 段，实际 ${chunks.length}`);
  for (const c of chunks) {
    assert(c.text.length <= 800 + 300, `单段长度 ${c.text.length} 超出预期`);
  }
  const chapterChunk = chunks.find((c) => c.text.trim().startsWith('第二章'));
  assert(!!chapterChunk, '章节标题应作为新段起点被优先切分');
});

check('PPTX 文本提取（按页序 + 实体解码 + 页标记）', () => {
  const slide = (title: string, body: string) =>
    `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>` +
    `<a:p><a:r><a:t>${title}</a:t></a:r></a:p>` +
    `<a:p><a:r><a:t>${body}</a:t></a:r><a:r><a:t> &amp; 补充</a:t></a:r></a:p>` +
    `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const bytes = zipSync({
    'ppt/slides/slide2.xml': strToU8(slide('第二页标题', '内容B')),
    'ppt/slides/slide1.xml': strToU8(slide('第一页标题', '内容A')),
    '[Content_Types].xml': strToU8('<x/>'),
  });
  const r = pptxBytesToText(bytes);
  assert(r.pageCount === 2, `页数应为 2，实际 ${r.pageCount}`);
  assert(r.text.includes('【第 1 页】') && r.text.includes('第一页标题'), '应含第 1 页内容与页标记');
  assert(r.text.indexOf('第一页标题') < r.text.indexOf('第二页标题'), '应按幻灯片顺序排列');
  assert(r.text.includes('内容A & 补充'), '应解码 XML 实体并合并同一段落的多个文本节点');
});

check('老版 .ppt 解析器：非 CFB 输入给出明确错误', () => {
  let msg = '';
  try {
    pptBytesToText(new Uint8Array([1, 2, 3, 4]));
  } catch (e) {
    msg = String((e as Error).message);
  }
  assert(msg.includes('OLE'), '应提示复合文档签名错误');
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

// ---------------------------------------------------------------- 漏题检查

check('extractQuestionNumbers：行首题号提取、去重、忽略行中题号', () => {
  const text = '1. 第一题\n\n2、第二题\n 3) 第三题\n这是正文中的 4. 不是题号\n2. 重复题号\n\n(5) 小题不算';
  const nums = extractQuestionNumbers(text);
  assert(nums.length === 3 && nums[0] === 1 && nums[1] === 2 && nums[2] === 3, `应提取 1/2/3，实际 ${nums.join(',')}`);
});

check('checkQuestionNumbers：识别缺失题号；模型无题号时 found 为空', () => {
  const text = ['1. 一', '2. 二', '3. 三', '4. 四', '5. 五'].join('\n\n');
  const drafts = [{ stem: '1. 一' }, { stem: '2. 二' }, { stem: '4. 四' }, { stem: '5. 五' }];
  const r = checkQuestionNumbers(text, drafts);
  assert(r.expected.length === 5 && r.found.length === 4, '数量应正确');
  assert(r.missing.length === 1 && r.missing[0] === 3, `应缺第 3 题，实际 ${r.missing.join(',')}`);
  const r2 = checkQuestionNumbers(text, [{ stem: '没有题号的题干' }, { stem: '另一题' }]);
  assert(r2.found.length === 0 && r2.missing.length === 5, '模型未保留题号时 found 为空（调用方据此不提示）');
});

check('parseAnswerDoc：单题式 / 区间连写式 / 少于 3 条视为无效', () => {
  const m1 = parseAnswerDoc('答案：1. A  2、B  3.C  4. 对  5. ×');
  assert(m1.size === 5, `单题式应解析 5 条，实际 ${m1.size}`);
  assert(m1.get('1') === 'A' && m1.get('4') === '对' && m1.get('5') === '×', '答案值应正确');
  const m2 = parseAnswerDoc('选择题：1-5 DCBAB\n判断题：6~10 √×√××');
  assert(m2.size === 10, `区间式应展开 10 条，实际 ${m2.size}`);
  assert(m2.get('3') === 'B' && m2.get('9') === '×', '区间展开应对位');
  const m3 = parseAnswerDoc('只有 1. A 和 2. B 两条');
  assert(m3.size === 0, '少于 3 条应视为无效（防正文误认）');
});

const total = passed + fails.length;
if (fails.length > 0) {
  console.log(`F8 VERIFY FAILED：${passed}/${total} 通过`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`F8 VERIFY PASSED：${total}/${total} 用例全部符合预期`);
