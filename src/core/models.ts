/**
 * 领域模型（唯一事实来源）。纯 TypeScript，不依赖 React Native / Expo，
 * 可直接在 Node 下做单元测试。依据：需求文档 §3.1 / §3.3。
 *
 * 注意：草稿生命周期（ImportItemStatus）与正式题目状态（QuestionStatus）
 * 是两套生命周期，禁止混用同一个字段表达。
 */

/**
 * fill：填空题/简答题共用（文本作答）——题干保留空位原文（如 ____），
 * options 为空数组，answer 为文本或 null。
 */
export type QuestionType = 'single' | 'multiple' | 'judge' | 'fill';

/** 模型输出的题型 → 领域题型（枚举外一律按单选处理，交给 F2 判无效） */
export function toQuestionType(raw: unknown): QuestionType {
  return raw === 'multiple' || raw === 'judge' || raw === 'fill' ? raw : 'single';
}

/** 正式题库中题目的状态（questions.status） */
export type QuestionStatus = 'pending' | 'approved' | 'disabled';

/** F2 校验结论（review_status） */
export type ReviewStatus = 'passed' | 'needs_review' | 'invalid';

/** 视觉特征固定枚举（§3.1）；模型给出枚举外的标记时，F2 会要求复核而不是丢弃 */
export const VISUAL_FEATURES = [
  'diagram_present',
  'formula_present',
  'table_present',
  'shared_passage',
  'cross_page',
  'option_boundary_uncertain',
  'answer_uncertain',
  'handwriting_present',
] as const;
export type VisualFeature = (typeof VISUAL_FEATURES)[number];

export interface QuestionOption {
  id: string;
  text: string;
}

/** 单选=选项ID字符串；多选=选项ID数组（去重）；判断=布尔；未知=null */
export type QuestionAnswer = string | string[] | boolean | null;

export interface QuestionDraft {
  type: QuestionType;
  stem: string;
  options: QuestionOption[];
  answer: QuestionAnswer;
  analysis?: string | null;
  tags?: string[] | null;
  /** 模型自评参考值，仅用于排序，不代表真实准确率 */
  confidence?: number | null;
  /** 需要人工复核的原因（模型给出 + F2 追加） */
  review_reasons: string[];
  visual_features: string[];
  source_image_path?: string | null;
  source_page?: number | null;
  source_hash?: string | null;
  /** 题目配图（从原图裁切的图形区域，可空） */
  question_image_path?: string | null;
  source_engine: 'zhipu' | 'doc';
  status: QuestionStatus;
  /** 由 F2 写入 */
  review_status?: ReviewStatus;
}

// ---------------------------------------------------------------- 导入任务

export type ImportBatchStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled';

export type ImportPageStatus =
  | 'queued'
  | 'processing'
  | 'recognized'
  | 'failed'
  | 'needs_review'
  | 'completed'
  | 'cancelled';

/** 草稿项生命周期（持久化在 import_items） */
export type ImportItemStatus =
  | 'draft'
  | 'needs_review'
  | 'approved_for_insert'
  | 'inserted'
  | 'discarded';

export type ImportSourceType = 'photo' | 'gallery' | 'pdf' | 'docx' | 'pptx' | 'txt' | 'md';

export interface ImportBatch {
  id: string;
  status: ImportBatchStatus;
  sourceType: ImportSourceType;
  createdAt: string;
  updatedAt: string;
  errorSummary?: string | null;
}

export interface ImportPage {
  id: string;
  batchId: string;
  status: ImportPageStatus;
  imagePath?: string | null;
  /** 原始页码/页面序号 */
  pageNo?: number | null;
  /** 识别尝试次数（含切半等兜底） */
  attempt: number;
  errorType?: string | null;
  updatedAt: string;
}

export interface ImportItem {
  id: string;
  batchId: string;
  pageId: string;
  status: ImportItemStatus;
  /** 草稿快照（含用户编辑后的状态） */
  draft: QuestionDraft;
  /** 模型原始输出的必要脱敏摘要（截断存储） */
  rawSummary?: string | null;
  /** 是否被用户编辑过 */
  edited: boolean;
  updatedAt: string;
}
