/**
 * F9b RAG 讲解 Prompt（§7.1 第 4 类 prompt 资产）。
 * 仅依据给定教材片段讲解、标注依据编号、依据不足回复固定句、禁止伪造引用。
 * CHANGELOG：
 * - 2026-10-16 v1：首版（配合 M4 RAG 讲解上线）。
 * - 2026-10-16 v2：应要求精简：正文 ≤150 字，不复述大段教材原文。
 */
import type { ExplainQuestionInput } from './explain';

export const RAG_PROMPT_VERSION = 'v2';

/** 教材片段不足时模型被要求回复的固定句：视为"无结果"，转为联网/模型知识确认入口 */
export const RAG_NO_EVIDENCE_REPLY = '当前导入教材未覆盖该知识点';

/** 模型回复是否只是"教材未覆盖"固定句（限短文本，避免误伤带该句的正常讲解） */
export function isNoEvidenceAnswer(text: string): boolean {
  const t = text.trim();
  return t.length <= 40 && t.includes('未覆盖该知识点');
}

export interface RagEvidence {
  index: number;
  text: string;
  source: string;
}

export function renderRagPrompt(q: ExplainQuestionInput, evidence: RagEvidence[]): string {
  const opts = q.options.length > 0 ? q.options.map((o) => `${o.id}. ${o.text}`).join('\n') : '（判断题）';
  const answer = q.answerText ? `已知答案：${q.answerText}` : '（试卷未提供答案）';
  const evidenceBlock = evidence
    .map((e) => `[${e.index}]（来源：${e.source}）\n${e.text}`)
    .join('\n\n');
  return `你是一位根据教材讲解题目的老师。你只能依据下面提供的教材片段来讲题，禁止使用教材之外的知识。

要求：
1. 直接给结论（正确答案），再结合教材依据给关键要点；只讲与本题直接相关的内容，不要复述大段教材原文；
2. 正文不超过 150 个中文字；
3. 在讲解中标注依据编号，例如"（依据[1]）"；
4. 只能引用下面实际给出的依据编号，禁止伪造引用；
5. 如果下面的教材片段不足以讲解这道题，直接回复"${RAG_NO_EVIDENCE_REPLY}"，不要编造；
6. 只输出讲解正文，不要使用 Markdown 代码围栏。

题目：
${q.stem}
${opts}
${answer}

教材依据：
${evidenceBlock}`;
}
