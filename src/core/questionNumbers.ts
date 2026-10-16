/**
 * 文档切题的漏题检查（纯函数）：
 * 对比"原文里的行首主题号"与"切出题目的题号（stem 开头保留的题号）"，
 * 找出疑似缺失的题号（防少题；模型没保留题号时 found 为空，由调用方决定不提示）。
 */

const QUESTION_START = /^\s*(\d{1,3})\s*[.、．)）]/;

/** 提取文本中的行首主题号（去重、保持出现顺序） */
export function extractQuestionNumbers(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const m = QUESTION_START.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export interface QuestionNumberCheck {
  expected: number[];
  found: number[];
  missing: number[];
}

export function checkQuestionNumbers(text: string, drafts: readonly unknown[]): QuestionNumberCheck {
  const expected = extractQuestionNumbers(text);
  const found: number[] = [];
  const seen = new Set<number>();
  for (const d of drafts) {
    const stem = d && typeof d === 'object' ? (d as Record<string, unknown>).stem : '';
    const m = typeof stem === 'string' ? QUESTION_START.exec(stem) : null;
    if (!m) continue;
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      found.push(n);
    }
  }
  const foundSet = new Set(found);
  return { expected, found, missing: expected.filter((n) => !foundSet.has(n)) };
}
