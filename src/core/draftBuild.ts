/**
 * 模型输出 → 领域草稿 的统一构建（图片识别与文档切题共用），
 * 内部先跑 F2，再把校验原因写入草稿。
 */
import type { QuestionAnswer, QuestionDraft } from './models';
import { toQuestionType } from './models';
import { f2ValidatePage, type F2Result } from './validation/f2';
import { normalizeOptions } from './validation/normalize';

export interface BuildDraftsOptions {
  sourceEngine: 'zhipu' | 'doc';
  sourceImagePath?: string | null;
  sourcePage?: number | null;
}

export function buildDraftsWithF2(
  raw: unknown[],
  opts: BuildDraftsOptions,
): { drafts: QuestionDraft[]; f2: F2Result[] } {
  const f2 = f2ValidatePage(raw);
  const drafts: QuestionDraft[] = raw.map((d, i) => {
    const base = (d && typeof d === 'object' && !Array.isArray(d) ? d : {}) as Record<string, unknown>;
    const r = f2[i];
    return {
      type: toQuestionType(base.type),
      stem: typeof base.stem === 'string' ? base.stem : '',
      options: normalizeOptions(Array.isArray(base.options) ? base.options : []).options,
      answer: (base.answer ?? null) as QuestionAnswer,
      analysis: null,
      tags: [],
      confidence: typeof base.confidence === 'number' ? base.confidence : null,
      review_reasons: r.issues.map((x) => x.message),
      visual_features: Array.isArray(base.visual_features) ? base.visual_features.map(String) : [],
      source_image_path: opts.sourceImagePath ?? null,
      source_page: opts.sourcePage ?? null,
      source_engine: opts.sourceEngine,
      status: 'pending',
      review_status: r.status,
    } as QuestionDraft;
  });
  return { drafts, f2 };
}
