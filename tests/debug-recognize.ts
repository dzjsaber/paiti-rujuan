/**
 * 临时调试：用生产识别 prompt 直连模型，检查原始输出与 ResponseParser 解析结果。
 * 用法：npx tsx tests/debug-recognize.ts <图片> [模型] [thinking enabled|disabled]
 * 需要环境变量 ZHIPU_API_KEY。
 */
import * as fs from 'node:fs';
import { RECOGNITION_PROMPT } from '../src/prompts/recognition';
import { f2ValidatePage } from '../src/core/validation/f2';
import { parseModelText } from '../src/services/llm/ResponseParser';

const imgPath = process.argv[2];
const model = process.argv[3] ?? 'glm-4.5v';
const thinking = process.argv[4] ?? 'enabled';
if (!imgPath) {
  console.log('用法: npx tsx tests/debug-recognize.ts <图片> [模型] [thinking]');
  process.exit(1);
}
const key = process.env.ZHIPU_API_KEY || '';
if (!key) {
  console.log('缺少 ZHIPU_API_KEY');
  process.exit(1);
}

async function main(): Promise<void> {
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const t0 = Date.now();
  const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: b64 } },
            { type: 'text', text: RECOGNITION_PROMPT },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 8192,
      thinking: { type: thinking },
    }),
  });
  const raw = await r.text();
  console.log(`model=${model} thinking=${thinking} status=${r.status} 耗时=${Date.now() - t0}ms`);
  if (r.status !== 200) {
    console.log('body:', raw.slice(0, 300));
    return;
  }
  const j = JSON.parse(raw) as {
    choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
    usage?: unknown;
  };
  const content = j.choices?.[0]?.message?.content ?? '';
  const reasoning = j.choices?.[0]?.message?.reasoning_content ?? '';
  console.log(
    `finish=${j.choices?.[0]?.finish_reason} content=${content.length}字 reasoning=${reasoning.length}字 usage=${JSON.stringify(j.usage)}`,
  );
  const parsed = parseModelText(content);
  console.log(`解析：mode=${parsed.mode} drafts=${parsed.drafts ? parsed.drafts.length : 'null'} error=${parsed.error ?? '无'}`);
  const outFile = (process.env.TEMP ?? '.') + '\\recognize_out.txt';
  fs.writeFileSync(outFile, content, 'utf8');
  console.log('原始输出已写', outFile);
  if (!parsed.drafts) console.log('输出首 600 字：\n' + content.slice(0, 600));
  if (parsed.drafts) {
    const f2 = f2ValidatePage(parsed.drafts);
    const s = { passed: 0, needs_review: 0, invalid: 0 };
    for (const r of f2) s[r.status] += 1;
    console.log(`F2 统计：passed=${s.passed} needs_review=${s.needs_review} invalid=${s.invalid}`);
    f2.forEach((r, i) => {
      if (r.status === 'invalid') console.log(`  invalid[${i}]: ${r.issues.map((x) => x.message).join('；')}`);
    });
  }
}

void main();
