/**
 * M1-C 验证：数据库映射纯函数 + FTS 辅助 + LLMService 重试/错误映射 + 识别引擎转发。
 * 运行：npx tsx tests/m1c.verify.ts
 */
import { draftToRowParams, rowToQuestion, type QuestionRow } from '../src/db/repo_questions';
import { escapeLike, shouldUseLike } from '../src/db/fts';
import { LLMService, type FetchLike } from '../src/services/llm/LLMService';
import { SseTextStream } from '../src/services/llm/sse';
import { ZhipuVisionEngine } from '../src/services/recognition/zhipuVision';
import type { QuestionDraft } from '../src/core/models';

let passed = 0;
const fails: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    fails.push(`${name}: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const DRAFT: QuestionDraft = {
  type: 'single',
  stem: '下列关于函数的说法正确的是',
  options: [
    { id: 'A', text: '甲' },
    { id: 'B', text: '乙' },
  ],
  answer: 'A',
  analysis: null,
  tags: ['函数'],
  confidence: 0.9,
  review_reasons: [],
  visual_features: ['formula_present'],
  source_image_path: '/tmp/a.jpg',
  source_page: 1,
  source_hash: 'H1',
  source_engine: 'zhipu',
  status: 'pending',
  review_status: 'needs_review',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function main(): Promise<void> {
  // ------------------------------------------------------------ 数据库映射
  await check('draft → INSERT 参数 → 行 → 领域模型 往返一致', () => {
    const p = draftToRowParams(DRAFT, 'bank_default', '2026-01-01T00:00:00Z');
    assert(typeof p.id === 'string' && p.id.startsWith('q_'), 'id 应带 q_ 前缀');
    const row: QuestionRow = {
      id: p.id,
      bank_id: 'bank_default',
      type: DRAFT.type,
      stem: DRAFT.stem,
      options_json: JSON.stringify(DRAFT.options),
      answer_json: JSON.stringify(DRAFT.answer),
      analysis: null,
      ai_explanation: null,
      tags_json: JSON.stringify(DRAFT.tags),
      confidence: DRAFT.confidence ?? null,
      review_reasons_json: '[]',
      visual_features_json: JSON.stringify(DRAFT.visual_features),
      source_image_path: DRAFT.source_image_path ?? null,
      source_page: 1,
      source_hash: 'H1',
      question_image_path: null,
      source_engine: 'zhipu',
      status: 'pending',
      review_status: 'needs_review',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const back = rowToQuestion(row);
    assert(back.stem === DRAFT.stem, 'stem 应一致');
    assert(JSON.stringify(back.options) === JSON.stringify(DRAFT.options), 'options 应一致');
    assert(back.answer === 'A', 'answer 应一致');
    assert(back.source_hash === 'H1', 'source_hash 应一致');
  });

  await check('answer 为 null 时序列化/反序列化为 null', () => {
    const p = draftToRowParams({ ...DRAFT, answer: null }, 'b', '2026-01-01T00:00:00Z');
    const answerJson = p.values[5];
    assert(answerJson === 'null', "answer_json 应为字符串 'null'");
  });

  // ------------------------------------------------------------ FTS 辅助
  await check('escapeLike 转义通配符', () => {
    assert(escapeLike('100%') === '100\\%', '应转义 %');
    assert(escapeLike('a_b') === 'a\\_b', '应转义 _');
    assert(escapeLike('c\\d') === 'c\\\\d', '应转义反斜杠');
  });

  await check('shouldUseLike：短于 3 字符走 LIKE 回退', () => {
    assert(shouldUseLike('细胞') === true, '2 字应为 LIKE');
    assert(shouldUseLike('函') === true, '1 字应为 LIKE');
    assert(shouldUseLike('细胞膜') === false, '3 字应为 MATCH');
    assert(shouldUseLike('DNA') === false, '英文缩写应为 MATCH');
    assert(shouldUseLike(' 细胞 ') === true, '空白应被忽略');
  });

  // ------------------------------------------------------------ LLMService
  await check('无 Key：不发起请求，返回可读提示', async () => {
    let called = 0;
    const fetchImpl: FetchLike = async () => {
      called += 1;
      return jsonResponse(200, {});
    };
    const svc = new LLMService(async () => null, fetchImpl);
    const r = await svc.complete('你好');
    assert(r.ok === false && r.attempts === 0, '应直接失败');
    assert(called === 0, '不应调用 fetch');
    assert(r.error?.userMessage.includes('API Key') === true, '应提示配置 Key');
  });

  await check('200：返回内容与 usage', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { choices: [{ message: { content: '  []  ' } }], usage: { total_tokens: 12 } });
    const svc = new LLMService(async () => 'k', fetchImpl);
    const r = await svc.complete('hi', { retryDelayMs: 0 });
    assert(r.ok === true && r.content === '  []  ', '应返回原始 content');
    assert(r.attempts === 1, '应一次成功');
  });

  await check('webSearch：请求体带智谱联网搜索工具参数（默认不带）', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    };
    const svc = new LLMService(async () => 'k', fetchImpl);
    await svc.complete('hi', { retryDelayMs: 0 });
    await svc.complete('hi', { retryDelayMs: 0, webSearch: true });
    assert(bodies.length === 2, '应发起两次请求');
    assert(!('tools' in bodies[0]), '默认请求不应带 tools');
    const tools = bodies[1].tools as { type: string; web_search?: { enable?: boolean } }[] | undefined;
    assert(Array.isArray(tools) && tools[0]?.type === 'web_search', '应带 web_search 工具');
    assert(tools?.[0]?.web_search?.enable === true, 'enable 应为 true');
  });

  await check('SseTextStream：跨块 JSON、[DONE] 终止、注释行忽略', () => {
    const s = new SseTextStream();
    assert(s.push('data: {"choices":[{"delta":{"content":"你') === '', '半截行应留在缓冲');
    const d1 = s.push('好"}}]}\ndata: {"choices":[{"delta":{"content":"世界"}}]}\n');
    assert(d1 === '你好世界', `应解析出两段增量，实际「${d1}」`);
    assert(s.push('data: [DONE]\n') === '', '[DONE] 不产生文本');
    assert(s.push('data: {"choices":[{"delta":{"content":"x"}}]}\n') === '', '结束后不再产出');
    const s2 = new SseTextStream();
    assert(s2.push(': keep-alive\n\ndata: {"choices":[{"delta":{"content":"A"}}]}\n') === 'A', '注释行应忽略');
  });

  await check('1305 限流：重试 1 次后失败，attempts=2 且可重试标记保留', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(429, { error: { code: '1305', message: '该模型当前访问量过大' } });
    };
    const svc = new LLMService(async () => 'k', fetchImpl);
    const r = await svc.complete('hi', { retryDelayMs: 0 });
    assert(calls === 2, '应尝试 2 次（1 次重试）');
    assert(r.ok === false && r.attempts === 2, '应失败且 attempts=2');
    assert(r.error?.retryable === true, '1305 应保留可重试标记（供补跑）');
  });

  await check('1211 模型不存在：不重试，attempts=1', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(400, { error: { code: '1211', message: '模型不存在' } });
    };
    const svc = new LLMService(async () => 'k', fetchImpl);
    const r = await svc.complete('hi', { retryDelayMs: 0 });
    assert(calls === 1, '永久性错误不应重试');
    assert(r.error?.retryable === false, '1211 不可重试');
  });

  await check('超时（AbortError）：重试 1 次', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      const e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    };
    const svc = new LLMService(async () => 'k', fetchImpl);
    const r = await svc.complete('hi', { retryDelayMs: 0 });
    assert(calls === 2, '超时应重试 1 次');
    assert(r.error?.userMessage.includes('超时') === true, '应给出超时文案');
  });

  // ------------------------------------------------------------ 识别引擎
  await check('ZhipuVisionEngine：转发 Base64 图片并返回原始文本', async () => {
    let captured: unknown = null;
    const fakeFetch: FetchLike = async (_url, init) => {
      captured = JSON.parse(String(init.body));
      return jsonResponse(200, { choices: [{ message: { content: '[]' } }] });
    };
    const llm = new LLMService(async () => 'k', fakeFetch);
    const engine = new ZhipuVisionEngine(llm);
    const r = await engine.recognize({ imageBase64: 'BASE64DATA', prompt: '识别' });
    assert(r.ok === true && r.raw === '[]', '应返回原始文本');
    const body = captured as { model: string; messages: { content: { type: string }[] }[] };
    assert(body.model === 'glm-4.6v-flash', '应使用 glm-4.6v-flash');
    assert(body.messages[0].content[0].type === 'image_url', '首块应为 image_url');
    assert(r.attempts === 1 && r.latencyMs >= 0, '应记录 attempts/latency');
  });

  const total = passed + fails.length;
  if (fails.length > 0) {
    console.log(`M1-C VERIFY FAILED：${passed}/${total} 通过`);
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`M1-C VERIFY PASSED：${total}/${total} 用例全部符合预期`);
}

void main();
