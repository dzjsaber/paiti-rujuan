/**
 * 模型响应解析（§8 ResponseParser）。纯 TypeScript，与 M0 验证脚本（m0_check.py）
 * 保持同一策略，并沿用 M0 实测结论：
 * 1) 严格 JSON 优先，其次去 Markdown 围栏，最后从说明文字中提取顶层平衡数组；
 * 2) 有限修复只做三件事：字符串内裸控制字符转义、未转义 LaTeX 反斜杠转义、
 *    剥离 <think> 段；
 * 3) 禁止把嵌套片段（如某题 options 数组）当作题目列表返回（M0 实测踩坑）。
 */

export type ParseMode =
  | 'strict'
  | 'fenced'
  | 'extracted'
  | 'strict_repaired'
  | 'fenced_repaired'
  | 'extracted_repaired'
  | 'failed';

export interface ParseResult {
  drafts: unknown[] | null;
  mode: ParseMode;
  error: string | null;
}

export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * 有限修复字符串值：
 * - 裸控制字符（字面换行等）→ 转义；
 * - LaTeX 反斜杠（\( \frac \left \begin \tan ...）→ 转义为字面反斜杠，
 *   避免 \f \b \t \r 被 JSON 静默解析成控制字符（M0 实测的隐性数据错误）。
 */
export function sanitizeJson(body: string): string {
  const out: string[] = [];
  let inStr = false;
  let i = 0;
  const n = body.length;
  const hex4 = /^[0-9a-fA-F]{4}$/;
  while (i < n) {
    const ch = body[i];
    if (!inStr) {
      out.push(ch);
      if (ch === '"') inStr = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      out.push(ch);
      inStr = false;
      i += 1;
      continue;
    }
    if (ch === '\n') {
      out.push('\\n');
      i += 1;
      continue;
    }
    if (ch === '\r') {
      out.push('\\r');
      i += 1;
      continue;
    }
    if (ch === '\t') {
      out.push('\\t');
      i += 1;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out.push('\\u' + code.toString(16).padStart(4, '0'));
      i += 1;
      continue;
    }
    if (ch === '\\') {
      const nxt = i + 1 < n ? body[i + 1] : '';
      if (nxt === 'b' || nxt === 'f' || nxt === 'n' || nxt === 'r' || nxt === 't') {
        const after = i + 2 < n ? body[i + 2] : '';
        if (/[A-Za-z]/.test(after)) {
          out.push('\\\\'); // 疑似 LaTeX 命令（\frac \begin ...）
          i += 1;
          continue;
        }
        out.push(ch, nxt);
        i += 2;
        continue;
      }
      if (nxt === '"' || nxt === '\\' || nxt === '/') {
        out.push(ch, nxt);
        i += 2;
        continue;
      }
      if (nxt === 'u' && hex4.test(body.slice(i + 2, i + 6))) {
        out.push(body.slice(i, i + 6));
        i += 6;
        continue;
      }
      out.push('\\\\'); // 其余为非法转义（\( \% \_ \left \sin ...）
      i += 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

export function tryParseArray(body: string): { obj: unknown[] | null; repaired: boolean | null } {
  try {
    const o = JSON.parse(body) as unknown;
    if (Array.isArray(o)) return { obj: o, repaired: false };
  } catch {
    /* 继续尝试修复 */
  }
  try {
    const o = JSON.parse(sanitizeJson(body)) as unknown;
    if (Array.isArray(o)) return { obj: o, repaired: true };
  } catch {
    /* 修复后仍失败 */
  }
  return { obj: null, repaired: null };
}

/** 返回 text[start] 处 '[' 的配对 ']' 下标；找不到返回 -1 */
export function findMatching(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 依次产出顶层平衡的 [...] 候选；解析失败的候选整体跳过，避免匹配到嵌套片段 */
export function* iterTopLevelArrays(text: string): Generator<string> {
  let pos = 0;
  for (;;) {
    const start = text.indexOf('[', pos);
    if (start === -1) return;
    const end = findMatching(text, start);
    if (end === -1) {
      pos = start + 1;
      continue;
    }
    yield text.slice(start, end + 1);
    pos = end + 1;
  }
}

export function parseModelText(text: string | null | undefined): ParseResult {
  if (text == null) return { drafts: null, mode: 'failed', error: '空响应' };
  const t = stripThinkTags(text);
  if (!t) return { drafts: null, mode: 'failed', error: '空文本' };

  const direct = tryParseArray(t);
  if (direct.obj) {
    return { drafts: direct.obj, mode: direct.repaired ? 'strict_repaired' : 'strict', error: null };
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    const inner = tryParseArray(fence[1].trim());
    if (inner.obj) {
      return { drafts: inner.obj, mode: inner.repaired ? 'fenced_repaired' : 'fenced', error: null };
    }
  }

  for (const cand of iterTopLevelArrays(t)) {
    const r = tryParseArray(cand);
    if (r.obj) {
      return { drafts: r.obj, mode: r.repaired ? 'extracted_repaired' : 'extracted', error: null };
    }
  }
  return { drafts: null, mode: 'failed', error: '未找到可解析的 JSON 数组（含有限修复）' };
}
