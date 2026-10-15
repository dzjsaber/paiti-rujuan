/**
 * 文末答案表解析与题号映射（§F8）。
 * 规则：只做确定性解析，不猜测对应关系；无法唯一映射时保持 answer=null 并标记复核；
 * 题号重复/缺失/格式不一致一律进入人工复核，不得盲配。
 */

export interface MappableDraft {
  stem: string;
  type: string;
  answer: unknown;
  review_reasons?: string[];
}

export interface ApplyAnswerResult {
  mapped: number;
  conflicts: number;
}

/** 解析文档中最后一个"答案/参考答案"标题之后的题号→答案表 */
export function parseAnswerTable(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const normalized = text.replace(/\r\n/g, '\n');
  const headRe = /(?:参考答案|答案(?:表|汇总|区)?)\s*[:：]?/g;
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(normalized))) lastIdx = m.index;
  if (lastIdx < 0) return map;

  const zone = normalized.slice(lastIdx);
  const re = /(\d{1,3})\s*[.、．:：)）]\s*([A-H]{1,4}|对|错|√|×|正确|错误|是|否)/g;
  let hit: RegExpExecArray | null;
  let guard = 0;
  while ((hit = re.exec(zone)) && guard < 1000) {
    guard += 1;
    if (!map.has(hit[1])) map.set(hit[1], hit[2]);
  }
  // 至少 3 条才视为有效答案表，避免把正文里偶发的"1、对"误认
  return map.size >= 3 ? map : new Map();
}

/** 从题干开头提取题号（"1." / "1、" / "第1题" 等） */
export function extractQuestionNo(stem: string): string | null {
  const m = /^\s*(?:第\s*)?(\d{1,3})\s*(?:题\s*[.、．:：]?|[.、．)）])/.exec(stem);
  return m ? m[1] : null;
}

function convertAnswer(raw: string, type: string): unknown {
  const t = raw.trim();
  if (type === 'judge') {
    if (/^(对|正确|√|是)$/.test(t)) return true;
    if (/^(错|错误|×|否)$/.test(t)) return false;
    return undefined;
  }
  if (type === 'single') return /^[A-H]$/.test(t) ? t : undefined;
  if (type === 'multiple') return /^[A-H]{2,4}$/.test(t) ? t.split('') : undefined;
  return undefined;
}

/**
 * 把答案表套用到切题结果上：
 * - 仅当题目当前 answer 为空、且题号能在答案表中唯一匹配时写入；
 * - 题号在同页重复、答案与题型不符时计入 conflicts 并标记复核原因。
 */
export function applyAnswerTable(drafts: MappableDraft[], table: Map<string, string>): ApplyAnswerResult {
  let mapped = 0;
  let conflicts = 0;
  if (table.size === 0) return { mapped, conflicts };
  const seen = new Set<string>();
  for (const d of drafts) {
    const no = extractQuestionNo(d.stem);
    if (!no) continue;
    if (seen.has(no)) {
      conflicts += 1;
      d.review_reasons = [...(d.review_reasons ?? []), `题号 ${no} 在文档中重复出现，答案未自动映射`];
      continue;
    }
    seen.add(no);
    const raw = table.get(no);
    if (!raw) continue;
    const converted = convertAnswer(raw, d.type);
    if (converted === undefined) {
      conflicts += 1;
      d.review_reasons = [...(d.review_reasons ?? []), `答案表第 ${no} 题答案「${raw}」与题型不符，需人工确认`];
      continue;
    }
    if (d.answer === null || d.answer === undefined) {
      d.answer = converted;
      d.review_reasons = [...(d.review_reasons ?? []), `答案来自文末答案表（第 ${no} 题）`];
      mapped += 1;
    }
  }
  return { mapped, conflicts };
}
