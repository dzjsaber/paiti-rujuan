/**
 * 机械归一化层：把"格式不对但语义明确"的字段转为规范形式，并记录每一步修复原因。
 * 用于两处：模型输出 → 草稿（记录原因、标记复核）；用户编辑后重新校验前。
 * 原则：只做机械转换，不猜测语义（禁止"补答案"式修复）。
 */
import type { QuestionAnswer, QuestionOption, QuestionType } from '../models';

export interface NormalizeAnswerResult {
  answer: QuestionAnswer;
  reasons: string[];
}

export interface NormalizeOptionsResult {
  options: QuestionOption[];
  reasons: string[];
}

const TRUE_TOKENS = new Set(['true', 't', '对', '正确', '√', '✓', '是', 'y', 'yes', '1']);
const FALSE_TOKENS = new Set(['false', 'f', '错', '错误', '×', '✗', 'x', '否', 'n', 'no', '0']);

export function normalizeAnswer(type: QuestionType, raw: unknown, optionIds: string[]): NormalizeAnswerResult {
  const reasons: string[] = [];
  if (raw === null || raw === undefined || raw === '') {
    return { answer: null, reasons };
  }
  const ids = optionIds.map((s) => s.trim().toUpperCase());

  if (type === 'judge') {
    if (typeof raw === 'boolean') return { answer: raw, reasons };
    if (typeof raw === 'string') {
      const t = raw.trim().toLowerCase();
      if (TRUE_TOKENS.has(t)) {
        reasons.push('判断题答案由文本归一化为 true');
        return { answer: true, reasons };
      }
      if (FALSE_TOKENS.has(t)) {
        reasons.push('判断题答案由文本归一化为 false');
        return { answer: false, reasons };
      }
    }
    return { answer: raw as QuestionAnswer, reasons };
  }

  if (type === 'fill') {
    // 填空/简答：答案为文本；数字转文本，空串视为无答案
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (t !== raw) reasons.push('填空/简答答案已去除首尾空白');
      return { answer: t || null, reasons };
    }
    if (typeof raw === 'number') {
      return { answer: String(raw), reasons: ['答案由数字转为文本'] };
    }
    return { answer: raw as QuestionAnswer, reasons };
  }

  if (type === 'single') {
    if (typeof raw === 'string') {
      const t = raw.trim().toUpperCase();
      if (t !== raw) reasons.push('单选答案已规范化为大写选项ID');
      return { answer: t, reasons };
    }
    if (typeof raw === 'number') {
      return { answer: String(raw), reasons: ['单选答案由数字转为字符串'] };
    }
    return { answer: raw as QuestionAnswer, reasons };
  }

  // multiple
  if (typeof raw === 'string') {
    const compact = raw.replace(/[\s,，、;；/|]+/g, '').toUpperCase();
    if (/^[A-Z]+$/.test(compact) && compact.length >= 2) {
      reasons.push('多选答案由字符串拆分为选项ID数组');
      return { answer: Array.from(new Set(compact.split(''))), reasons };
    }
    const parts = raw
      .split(/[\s,，、;；/|]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (parts.length >= 2) {
      reasons.push('多选答案由分隔文本转为数组');
      return { answer: Array.from(new Set(parts)), reasons };
    }
    return { answer: raw as QuestionAnswer, reasons };
  }
  if (Array.isArray(raw)) {
    const arr = raw.map((x) => String(x).trim().toUpperCase());
    if (arr.some((x, i) => x !== raw[i])) reasons.push('多选答案元素已规范化');
    const uniq = Array.from(new Set(arr));
    if (uniq.length !== arr.length) reasons.push('多选答案已去除重复项');
    return { answer: uniq, reasons };
  }
  return { answer: raw as QuestionAnswer, reasons };
}

const OPT_PREFIX = /^([A-Za-z])[.、．:：)）\s]+(.+)$/s;

export function normalizeOptions(raw: unknown): NormalizeOptionsResult {
  const reasons: string[] = [];
  if (!Array.isArray(raw)) {
    return { options: [], reasons: ['options 不是数组，无法归一化'] };
  }
  const out: QuestionOption[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id : typeof o.key === 'string' ? (o.key as string) : '';
      const text = typeof o.text === 'string' ? o.text : typeof o.value === 'string' ? (o.value as string) : '';
      if (id || text) {
        out.push({ id: id.trim(), text: text.trim() });
        continue;
      }
      // {"A": "选项文本"} 形式
      const entries = Object.entries(o);
      if (entries.length === 1 && typeof entries[0][1] === 'string') {
        out.push({ id: entries[0][0].trim(), text: (entries[0][1] as string).trim() });
        reasons.push('选项由单键对象转为 {id,text}');
        continue;
      }
    }
    if (typeof item === 'string') {
      const m = OPT_PREFIX.exec(item.trim());
      if (m) {
        out.push({ id: m[1].toUpperCase(), text: m[2].trim() });
        reasons.push('选项由字符串拆分为 {id,text}');
        continue;
      }
    }
    // 无法识别的项：原样输出为无 id 项，交给 F2 判无效
    out.push({ id: '', text: typeof item === 'string' ? item : '' });
    reasons.push('存在无法识别的选项格式');
  }
  return { options: out, reasons };
}
