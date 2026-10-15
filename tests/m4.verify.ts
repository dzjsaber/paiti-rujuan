/** M4 纯逻辑验证：检索片段提取 + 讲解 prompt 构造。运行：npx tsx tests/m4.verify.ts */
import { buildSearchTerms, clipHitText } from '../src/core/searchTerms';
import { renderExplainPrompt } from '../src/prompts/explain';
import { renderRagPrompt, type RagEvidence } from '../src/prompts/ragExplain';
import { DEEPSEEK_URL, resolveExplainTarget, ZHIPU_URL, type ExplainSecrets } from '../src/services/llm/providerDefs';

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

check('buildSearchTerms：3 字滑窗、清理标点、去重、上限', () => {
  const terms = buildSearchTerms('已知点A在函数y=6/x的图象上，且x1<0<x2，则下列结论正确的是（ ）');
  assert(terms.length > 0, '应有片段');
  assert(terms.every((t) => t.length === 3), '片段应均为 3 字窗口');
  assert(terms.includes('下列结') || terms.includes('列结论'), '应含题干关键位置窗口');
  assert(terms.length <= 41, '不超过上限（+尾部兜底 1 个）');
  const long = buildSearchTerms('这是一个非常非常非常非常非常长的连续中文句子没有标点'.repeat(3), 10);
  assert(long.length <= 11, '长文本应按上限采样');
  assert(long.includes('有标点'), '采样应保证覆盖串尾');
  assert(buildSearchTerms('ab').length === 0, '全部过短时返回空');
});

check('clipHitText：短片段原样、锚居中取锚窗、锚在头部取头尾双窗', () => {
  const short = 'A'.repeat(500);
  assert(clipHitText(short, ['x']) === short, '≤600 字应原样返回');
  const mid = 'A'.repeat(400) + '关键词' + 'B'.repeat(400);
  const c1 = clipHitText(mid, ['关键词']);
  assert(c1.includes('关键词') && c1.startsWith('……'), '锚居中应取锚窗');
  const head = '关键词' + 'C'.repeat(800);
  const c2 = clipHitText(head, ['关键词']);
  assert(c2.includes('关键词'), '头尾双窗应含头部锚');
  assert(c2.includes('……'), '双窗应带省略连接');
});

check('renderExplainPrompt：包含题干/选项/答案与关键要求', () => {
  const p = renderExplainPrompt({
    stem: '下列计算正确的是',
    options: [
      { id: 'A', text: '1+1=2' },
      { id: 'B', text: '1+1=3' },
    ],
    answerText: 'A',
  });
  assert(p.includes('下列计算正确的是'), '含题干');
  assert(p.includes('A. 1+1=2') && p.includes('B. 1+1=3'), '含选项');
  assert(p.includes('已知答案：A'), '含答案');
  assert(p.includes('150'), '含字数要求（精简版 ≤150 字）');
  assert(p.includes('禁止编造'), '含防编造要求');
});

check('renderExplainPrompt：判断题（无选项）', () => {
  const p = renderExplainPrompt({ stem: '该说法正确。', options: [], answerText: '正确' });
  assert(p.includes('（判断题）'), '应标注判断题');
  assert(p.includes('已知答案：正确'), '含答案');
});

check('renderRagPrompt：依据编号/来源/固定回复要求', () => {
  const evidence: RagEvidence[] = [
    { index: 1, text: '教材片段一', source: '数学教材 · 第 10 页' },
    { index: 2, text: '教材片段二', source: '数学教材 · 第 12 页' },
  ];
  const p = renderRagPrompt({ stem: '题干', options: [{ id: 'A', text: '甲' }], answerText: '' }, evidence);
  assert(p.includes('[1]（来源：数学教材 · 第 10 页）'), '含依据编号与来源');
  assert(p.includes('教材片段一') && p.includes('教材片段二'), '含依据正文');
  assert(p.includes('当前导入教材未覆盖该知识点'), '含固定回复句');
  assert(p.includes('禁止伪造引用'), '含防伪引用要求');
  assert(p.includes('（试卷未提供答案）'), '无答案时标注');
  assert(p.includes('150') && p.includes('不要复述'), '含精简要求');
});

const NO_SECRETS: ExplainSecrets = {
  zhipuApiKey: null,
  deepseekApiKey: null,
  custom: { url: '', model: '', apiKey: '' },
};

check('resolveExplainTarget：智谱免费（无 Key 提示 / 有 Key 指向 glm-4.7-flash）', () => {
  assert(resolveExplainTarget('zhipu_free', NO_SECRETS).kind === 'missing_config', '无 Key 应提示配置');
  const ok = resolveExplainTarget('zhipu_free', { ...NO_SECRETS, zhipuApiKey: 'k' });
  assert(ok.kind === 'api' && ok.url === ZHIPU_URL && ok.model === 'glm-4.7-flash', '免费档应指向 glm-4.7-flash');
});

check('resolveExplainTarget：智谱高级 → glm-5.3', () => {
  const t = resolveExplainTarget('zhipu_pro', { ...NO_SECRETS, zhipuApiKey: 'k' });
  assert(t.kind === 'api' && t.model === 'glm-5.3', '高级档应指向 glm-5.3');
});

check('resolveExplainTarget：DeepSeek（无 Key 提示 / 有 Key 指向官方端点）', () => {
  assert(resolveExplainTarget('deepseek', NO_SECRETS).kind === 'missing_config', '无 Key 应提示');
  const ok = resolveExplainTarget('deepseek', { ...NO_SECRETS, deepseekApiKey: 'd' });
  assert(ok.kind === 'api' && ok.url === DEEPSEEK_URL && ok.model === 'deepseek-chat', '应指向 DeepSeek 官方端点');
});

check('resolveExplainTarget：自定义（缺项逐级提示 / 完整通过）', () => {
  assert(resolveExplainTarget('custom', NO_SECRETS).kind === 'missing_config', '缺 URL 应提示');
  const noModel = resolveExplainTarget('custom', {
    ...NO_SECRETS,
    custom: { url: 'https://x/v1/chat/completions', model: '', apiKey: 'k' },
  });
  assert(noModel.kind === 'missing_config' && noModel.message.includes('模型名'), '缺模型名应提示');
  const full = resolveExplainTarget('custom', {
    ...NO_SECRETS,
    custom: { url: 'https://x/v1/chat/completions', model: 'm', apiKey: 'k' },
  });
  assert(full.kind === 'api' && full.url === 'https://x/v1/chat/completions' && full.model === 'm', '完整配置应通过');
});

check('resolveExplainTarget：分享模式', () => {
  assert(resolveExplainTarget('external', { ...NO_SECRETS, zhipuApiKey: 'k' }).kind === 'share', '应为分享模式');
});

const total = passed + fails.length;
if (fails.length > 0) {
  console.log(`M4 VERIFY FAILED：${passed}/${total} 通过`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`M4 VERIFY PASSED：${total}/${total} 用例全部符合预期`);
