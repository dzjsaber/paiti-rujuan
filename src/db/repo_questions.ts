/**
 * 题目仓库层：入库（单题独立事务）、查询、状态变更、删除级联。
 * 行 ↔ 领域模型映射拆成纯函数，便于离线单测。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QuestionAnswer, QuestionDraft, QuestionOption, QuestionStatus, QuestionType, ReviewStatus } from '../core/models';
import { newId } from '../core/ids';

export interface QuestionRow {
  id: string;
  bank_id: string;
  type: string;
  stem: string;
  options_json: string;
  answer_json: string;
  /** 题目自带解析（试卷/文档导入时提取，或被人工编辑；AI 讲解不写这里） */
  analysis: string | null;
  /** AI 讲解（生成后自动保存，与自带解析分开存储） */
  ai_explanation: string | null;
  tags_json: string;
  confidence: number | null;
  review_reasons_json: string;
  visual_features_json: string;
  source_image_path: string | null;
  source_page: number | null;
  source_hash: string | null;
  question_image_path: string | null;
  source_engine: string;
  status: string;
  review_status: string;
  favorite: number;
  created_at: string;
  updated_at: string;
}

export interface QuestionRowParams {
  id: string;
  values: (string | number | null)[];
}

const INSERT_SQL = `INSERT INTO questions(
  id, bank_id, type, stem, options_json, answer_json, analysis, tags_json, confidence,
  review_reasons_json, visual_features_json, source_image_path, source_page, source_hash,
  question_image_path, source_engine, status, review_status, created_at, updated_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** 纯映射：草稿 → INSERT 参数（离线可测） */
export function draftToRowParams(
  draft: QuestionDraft,
  bankId: string,
  nowIso: string,
): QuestionRowParams {
  const id = newId('q');
  return {
    id,
    values: [
      id,
      bankId,
      draft.type,
      draft.stem,
      JSON.stringify(draft.options ?? []),
      JSON.stringify(draft.answer ?? null),
      draft.analysis ?? null,
      JSON.stringify(draft.tags ?? []),
      draft.confidence ?? null,
      JSON.stringify(draft.review_reasons ?? []),
      JSON.stringify(draft.visual_features ?? []),
      draft.source_image_path ?? null,
      draft.source_page ?? null,
      draft.source_hash ?? null,
      draft.question_image_path ?? null,
      draft.source_engine,
      draft.status,
      draft.review_status ?? 'needs_review',
      nowIso,
      nowIso,
    ],
  };
}

/** 纯映射：行 → 领域模型（离线可测） */
export function rowToQuestion(row: QuestionRow): QuestionDraft & { id: string; bankId: string; createdAt: string; updatedAt: string } {
  return {
    id: row.id,
    bankId: row.bank_id,
    type: row.type as QuestionType,
    stem: row.stem,
    options: JSON.parse(row.options_json) as QuestionOption[],
    answer: JSON.parse(row.answer_json) as QuestionAnswer,
    analysis: row.analysis,
    tags: JSON.parse(row.tags_json) as string[],
    confidence: row.confidence,
    review_reasons: JSON.parse(row.review_reasons_json) as string[],
    visual_features: JSON.parse(row.visual_features_json) as string[],
    source_image_path: row.source_image_path,
    source_page: row.source_page,
    source_hash: row.source_hash,
    question_image_path: row.question_image_path,
    source_engine: row.source_engine as 'zhipu' | 'doc',
    status: row.status as QuestionStatus,
    review_status: row.review_status as ReviewStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 单题入库（调用方应在自己事务里调用，单题失败不影响其他题） */
export async function insertQuestion(db: SQLiteDatabase, bankId: string, draft: QuestionDraft): Promise<string> {
  const p = draftToRowParams(draft, bankId, new Date().toISOString());
  await db.runAsync(INSERT_SQL, ...p.values);
  return p.id;
}

export async function listQuestions(
  db: SQLiteDatabase,
  bankId: string,
  limit = 50,
  offset = 0,
): Promise<QuestionRow[]> {
  return db.getAllAsync<QuestionRow>(
    'SELECT * FROM questions WHERE bank_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    bankId,
    limit,
    offset,
  );
}

export async function setQuestionStatus(db: SQLiteDatabase, id: string, status: QuestionStatus): Promise<void> {
  await db.runAsync('UPDATE questions SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id);
}

export async function deleteQuestion(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM questions WHERE id = ?', id);
  await db.runAsync('DELETE FROM questions_fts WHERE ref_id = ?', id);
}

export async function countQuestions(db: SQLiteDatabase, bankId: string): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM questions WHERE bank_id = ?', bankId);
  return row?.c ?? 0;
}

/** 全部题库的题目总数（首页统计用） */
export async function countAllQuestions(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM questions');
  return row?.c ?? 0;
}

/** 写入/清除 AI 讲解（与自带解析 analysis 分开；传 null 表示删除讲解） */
export async function setQuestionExplanation(db: SQLiteDatabase, id: string, text: string | null): Promise<void> {
  await db.runAsync('UPDATE questions SET ai_explanation = ?, updated_at = ? WHERE id = ?', text, new Date().toISOString(), id);
}

/** 收藏/取消收藏（刷题界面星标；支持"只刷收藏"模式） */
export async function setQuestionFavorite(db: SQLiteDatabase, id: string, favorite: boolean): Promise<void> {
  await db.runAsync('UPDATE questions SET favorite = ?, updated_at = ? WHERE id = ?', favorite ? 1 : 0, new Date().toISOString(), id);
}

/** 写入题目答案（"识别答案文档"补答案用；状态同步为已确认） */
export async function setQuestionAnswer(db: SQLiteDatabase, id: string, answer: unknown): Promise<void> {
  await db.runAsync(
    'UPDATE questions SET answer_json = ?, status = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(answer ?? null),
    'approved',
    new Date().toISOString(),
    id,
  );
}

/**
 * 编辑已入库题目（题干/选项/答案/自带解析/校验状态），并同步 FTS 索引。
 * 不入库 ai_explanation（AI 讲解由练习页单独管理）。
 * 调用方须传入完整的 draft（含当前 analysis），否则解析会被置空。
 */
export async function updateQuestionContent(
  db: SQLiteDatabase,
  id: string,
  draft: QuestionDraft,
): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE questions SET stem = ?, options_json = ?, answer_json = ?, analysis = ?, review_status = ?,
        review_reasons_json = ?, question_image_path = ?, updated_at = ? WHERE id = ?`,
      draft.stem,
      JSON.stringify(draft.options ?? []),
      JSON.stringify(draft.answer ?? null),
      draft.analysis ?? null,
      draft.review_status ?? 'needs_review',
      JSON.stringify(draft.review_reasons ?? []),
      draft.question_image_path ?? null,
      new Date().toISOString(),
      id,
    );
    await db.runAsync('DELETE FROM questions_fts WHERE ref_id = ?', id);
    await db.runAsync('INSERT INTO questions_fts(stem, ref_id) VALUES(?, ?)', draft.stem, id);
  });
}
