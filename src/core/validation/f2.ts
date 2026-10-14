/**
 * F2 确定性校验层（纯代码，不依赖 AI）。依据需求文档 §3.2 与 F2 章节（V1-V10）。
 *
 * 设计要点（均有 M0 实测依据）：
 * - 模型自评 confidence 不可靠（实测全为 0）：0 或缺失一律要求人工复核；
 * - 模型会输出枚举外类型（解答/填空/操作）：一律判 invalid，由 UI 提示"暂不支持"；
 * - 归一化是可选项：默认对模型原始输出严格校验；链路中可用 normalize 选项先做机械修复。
 */
import type { QuestionType, ReviewStatus } from '../models';
import { VISUAL_FEATURES } from '../models';
import { stemHash } from '../dedupe';
import { normalizeAnswer, normalizeOptions } from './normalize';

export interface F2Issue {
  rule: string;
  message: string;
}

export interface F2Result {
  status: ReviewStatus;
  issues: F2Issue[];
}

export interface F2Options {
  /** 校验前做机械归一化（多选字符串拆分、判断题文本布尔化等），修复原因会进入 issues */
  normalize?: boolean;
  /** V9：要求题目可追溯到来源（照片路径或页码），缺失则复核 */
  requireSource?: boolean;
  /** V6 阈值，默认 0.7 */
  confidenceThreshold?: number;
  /** 题干过短阈值（字符数），默认 5 */
  minStemLength?: number;
}

const QUESTION_TYPES: ReadonlySet<string> = new Set<QuestionType>(['single', 'multiple', 'judge']);

function invalid(...messages: string[]): F2Result {
  return { status: 'invalid', issues: messages.map((m) => ({ rule: m.slice(0, 2), message: m })) };
}

export function f2ValidateQuestion(input: unknown, opts: F2Options = {}): F2Result {
  const issues: F2Issue[] = [];
  let needsReview = false;
  const addReview = (rule: string, message: string) => {
    needsReview = true;
    issues.push({ rule, message });
  };

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('V1: 题目不是对象');
  }
  const q = input as Record<string, unknown>;

  const type = q.type;
  if (typeof type !== 'string' || !QUESTION_TYPES.has(type)) {
    return invalid(`V1/V2: type 非法「${String(type)}」，一期仅支持 single/multiple/judge`);
  }
  const qtype = type as QuestionType;

  const stem = typeof q.stem === 'string' ? q.stem.trim() : '';
  if (!stem) return invalid('V4: 题干为空或非文本');
  const minLen = opts.minStemLength ?? 5;
  if (stem.length < minLen) addReview('V4', `题干过短（${stem.length} < ${minLen} 字符）`);

  let options = Array.isArray(q.options) ? (q.options as unknown[]) : q.options === undefined || q.options === null ? [] : null;
  if (options === null) return invalid('V1: options 不是数组');
  if (opts.normalize) {
    const n = normalizeOptions(options);
    options = n.options as unknown[];
    for (const r of n.reasons) addReview('N1', r);
  }
  const normOptions: { id: string; text: string }[] = [];
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (!o || typeof o !== 'object' || Array.isArray(o)) return invalid(`V1: 选项[${i}] 不是对象`);
    const oo = o as Record<string, unknown>;
    const id = typeof oo.id === 'string' ? oo.id.trim() : '';
    const text = typeof oo.text === 'string' ? oo.text.trim() : '';
    if (!id) return invalid(`V3: 选项[${i}] id 为空`);
    if (!text) return invalid(`V3: 选项[${i}] 文本为空`);
    normOptions.push({ id, text });
  }
  const ids = normOptions.map((o) => o.id);
  if (new Set(ids).size !== ids.length) return invalid('V3: 选项 id 重复');

  let answer = q.answer;
  if (opts.normalize) {
    const n = normalizeAnswer(qtype, answer, ids);
    answer = n.answer;
    for (const r of n.reasons) addReview('N2', r);
  }

  if (qtype === 'single' || qtype === 'multiple') {
    if (normOptions.length < 2) return invalid('V3: 选择题有效选项不足 2 个');
    if (answer === null || answer === undefined) {
      addReview('V8', '答案缺失（null），入库后等待补充');
    } else if (qtype === 'single') {
      if (typeof answer !== 'string' || !ids.includes(answer)) {
        return invalid(`V2: 单选答案非法或越界「${String(answer)}」`);
      }
    } else {
      if (!Array.isArray(answer)) {
        return invalid(`V2: 多选答案必须是选项ID数组（实际 ${typeof answer}）`);
      }
      const arr = answer as unknown[];
      const seen = new Set<string>();
      for (const a of arr) {
        if (typeof a !== 'string' || !ids.includes(a)) return invalid(`V2: 多选答案元素非法或越界「${String(a)}」`);
        if (seen.has(a)) return invalid('V2: 多选答案含重复项');
        seen.add(a);
      }
      if (seen.size < 2) return invalid('V2: 多选答案有效项不足 2 个');
    }
  } else {
    // judge
    if (answer === null || answer === undefined) {
      addReview('V8', '答案缺失（null），入库后等待补充');
    } else if (typeof answer !== 'boolean') {
      return invalid(`V2: 判断题答案必须是布尔值（实际 ${typeof answer}）`);
    }
  }

  const conf = q.confidence;
  const threshold = opts.confidenceThreshold ?? 0.7;
  if (typeof conf !== 'number' || Number.isNaN(conf)) {
    addReview('V6', 'confidence 缺失或非数值');
  } else if (conf <= 0) {
    addReview('V6', 'confidence 为 0，需对照原图确认');
  } else if (conf < threshold) {
    addReview('V6', `confidence 低（${conf} < ${threshold}）`);
  }

  const vf = q.visual_features;
  if (Array.isArray(vf) && vf.length > 0) {
    const unknownFlags = vf.filter((f) => typeof f === 'string' && !(VISUAL_FEATURES as readonly string[]).includes(f));
    addReview('V7', `视觉特征：${vf.map(String).join(',')}`);
    if (unknownFlags.length > 0) addReview('V7', `枚举外视觉特征：${unknownFlags.map(String).join(',')}`);
  }
  const rr = q.review_reasons;
  if (Array.isArray(rr) && rr.length > 0) {
    addReview('V7', `模型自报复核原因：${rr.map(String).join('；')}`);
  }

  if (opts.requireSource) {
    const hasSource = (typeof q.source_image_path === 'string' && q.source_image_path) || typeof q.source_page === 'number';
    if (!hasSource) addReview('V9', '缺少来源（图片路径或页码）');
  }

  return { status: needsReview ? 'needs_review' : 'passed', issues };
}

/**
 * 整页校验：逐题执行 f2ValidateQuestion，并追加 V5 页内疑似重复检测。
 * 仅题干、题型相同的条目会被标记为"疑似重复"（不自动删除）。
 */
export function f2ValidatePage(inputs: unknown[], opts: F2Options = {}): F2Result[] {
  const results: F2Result[] = [];
  const seen = new Map<string, number>();
  inputs.forEach((item, idx) => {
    const r = f2ValidateQuestion(item, opts);
    const q = item as Record<string, unknown> | null;
    const stem = q && typeof q.stem === 'string' ? q.stem : '';
    if (stem) {
      const h = `${String(q?.type ?? '')}:${stemHash(stem)}`;
      const prev = seen.get(h);
      if (prev !== undefined) {
        const clone: F2Result = { status: r.status === 'invalid' ? 'invalid' : 'needs_review', issues: [...r.issues] };
        clone.issues.push({ rule: 'V5', message: `与第 ${prev + 1} 题题干疑似重复` });
        results.push(clone);
        return;
      }
      seen.set(h, idx);
    }
    results.push(r);
  });
  return results;
}

export function f2Summary(results: F2Result[]): { passed: number; needs_review: number; invalid: number } {
  const s = { passed: 0, needs_review: 0, invalid: 0 };
  for (const r of results) s[r.status] += 1;
  return s;
}
