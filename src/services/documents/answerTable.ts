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

/**
 * 解析"整份都是答案"的文档（可无"参考答案"标题）：全文扫描题号→答案对。
 * 支持：单题式（"1.A" / "2、对"）、区间连写式（"1-5 DCBAB" / "6~10 √×√××"）。
 * 至少 3 条才视为有效，避免把正文里的偶发格式误认成答案。
 */
export function parseAnswerDoc(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const normalized = text.replace(/\r\n/g, '\n');
  // 区间连写式：题号范围 + 等长答案串（字母或对错符号逐字对应）
  const rangeRe = /(?:^|[\s\n，,、;；：:])(\d{1,3})\s*[-–~～]\s*(\d{1,3})\s*[.、．:：)）]?\s*((?:[A-Ha-h]|[对错√×]){2,20})/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = rangeRe.exec(normalized)) && guard < 200) {
    guard += 1;
    const start = Number(m[1]);
    const end = Number(m[2]);
    const seq = Array.from(m[3]);
    if (end - start + 1 !== seq.length) continue; // 长度对不上，放弃该区间
    for (let i = 0; i < seq.length; i++) {
      const no = String(start + i);
      if (!map.has(no)) map.set(no, seq[i]);
    }
  }
  // 单题式
  const singleRe = /(?:^|[\s\n，,、;；：:])(\d{1,3})\s*[.、．:：)）]\s*([A-Ha-h]{1,4}|对|错|√|×|正确|错误|是|否)(?=$|[\s\n，,、;；])/g;
  guard = 0;
  while ((m = singleRe.exec(normalized)) && guard < 1000) {
    guard += 1;
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map.size >= 3 ? map : new Map();
}

/**
 * 逐行答案解析（支持"题号 + 题型标注 + 答案 + 括号注释"的手动整理格式，如：
 *   "1.（单选）B（哈福/哈佛结构）" → 1=B；"8.（判断）×（PC是16位）" → 8=×；
 *   "9.（填空）工作寄存器组" → 9=工作寄存器组；"10.（简答参考）：RST引脚…" → 10=RST引脚…
 * 规则：剥掉行首的题型/注释括号；剩余若以单个选项字母或对错符号开头，答案为该符号；
 * 否则整段作为文本答案（填空/简答）。至少 3 条才视为有效。
 */
export function parseLineAnswers(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    const m = /^(\d{1,3})\s*[.、．:：)）]\s*(.+)$/.exec(line);
    if (!m) continue;
    const no = m[1];
    let rest = m[2].trim();
    // 剥题型标注（括号内最多 12 字且含题型关键字，如"（单选）""（简答参考）"）
    rest = rest.replace(
      /^[（(]\s*(?=[^）)]{0,12}[）)])(?=[^）)]*(?:单选|多选|判断|填空|简答|解答|参考|答案))[^）)]{0,12}[）)]\s*[:：]?\s*/,
      '',
    );
    // 再剥一层任意短括号（注释型前缀）
    rest = rest.replace(/^[（(][^）)]{0,12}[）)]\s*[:：]?\s*/, '');
    if (!rest) continue;
    const head = /^([A-Ha-h])(?![A-Za-z])/.exec(rest) ?? /^(√|×|正确|错误|对|错)(?![^\s（(])/.exec(rest);
    if (head) {
      map.set(no, head[1].toUpperCase());
      continue;
    }
    const ansM = /^(?:答案|参考答案)\s*[:：]?\s*(.+)$/.exec(rest);
    if (ansM) rest = ansM[1].trim();
    if (!rest) continue;
    map.set(no, rest);
  }
  return map.size >= 3 ? map : new Map();
}

/** 解析模型输出的规范化答案 JSON（[{"no":"1","answer":"B"}]，容忍围栏与前后噪声） */
export function parseModelAnswerJson(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const body = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  let arr: unknown;
  try {
    arr = JSON.parse(body);
  } catch {
    const s = body.indexOf('[');
    const e = body.lastIndexOf(']');
    if (s < 0 || e <= s) return map;
    try {
      arr = JSON.parse(body.slice(s, e + 1));
    } catch {
      return map;
    }
  }
  if (!Array.isArray(arr)) return map;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const no = String(o.no ?? '').trim();
    const answer = String(o.answer ?? '').trim();
    if (/^\d{1,3}$/.test(no) && answer) map.set(no, answer);
  }
  return map;
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
