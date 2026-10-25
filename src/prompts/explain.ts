/**
 * F7 AI 讲解 Prompt（§7.1 第 3 类 prompt 资产）。
 * 先结论后要点、正文 ≤150 中文字、证据不足必须说明不确定、禁止编造。
 * CHANGELOG：
 * - 2026-10-16 v1：首版（配合 M4 讲解功能上线）。
 * - 2026-10-16 v2：应要求精简：正文 ≤150 字，不复述题面/教材原文，只讲本题要点。
 */

export const EXPLAIN_PROMPT_VERSION = 'v2';

export interface ExplainQuestionInput {
  stem: string;
  options: { id: string; text: string }[];
  answerText: string;
  analysis?: string | null;
}

function renderQuestionBlock(q: ExplainQuestionInput): string {
  const opts = q.options.length > 0 ? q.options.map((o) => `${o.id}. ${o.text}`).join('\n') : '（判断题）';
  const answer = q.answerText ? `已知答案：${q.answerText}` : '（试卷未提供答案）';
  return `${q.stem}\n${opts}\n${answer}`;
}

export function renderExplainPrompt(q: ExplainQuestionInput): string {
  return `你是一位耐心的题目讲解老师。请讲解下面这道题。

要求：
1. 直接给结论（正确答案），再给与本题直接相关的关键要点；不要复述题面，不要展开无关知识；
2. 正文不超过 150 个中文字；
3. 如果题目信息不足以确定答案，必须明确说明"题目信息不足，无法确定"，禁止编造；
4. 如果已知答案与题干、选项或推理明显冲突，必须明确提示"题目或答案可能有误"，不要强行为错误答案辩护；
5. 只输出讲解正文，不要使用 Markdown 代码围栏，不要输出 JSON。

题目：
${renderQuestionBlock(q)}`;
}
