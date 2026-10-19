/**
 * 检索层（§3.3）：FTS5 trigram + 短查询 LIKE 回退。
 * 真机实测（2026-10-15，SQLite 3.50.3）：trigram 建表成功；3 字查询可用 MATCH 命中；
 * 短于 3 字符的查询 MATCH 返回 0 条，必须走参数化 LIKE 回退。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { buildSearchTerms } from '../core/searchTerms';

export interface SearchHit {
  refId: string;
  text: string;
}

const MIN_TRIGRAM_LEN = 3;

/** 转义 LIKE 通配符，避免用户输入 % _ 造成全表模糊 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => '\\' + m);
}

export function shouldUseLike(query: string): boolean {
  // 以"字符数"判断：中文 1 字 = 1，短查询无法由 trigram 稳定匹配
  return Array.from(query.trim()).length < MIN_TRIGRAM_LEN;
}

export async function searchQuestions(db: SQLiteDatabase, query: string, limit = 20): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  if (shouldUseLike(q)) {
    const rows = await db.getAllAsync<{ ref_id: string; stem: string }>(
      'SELECT q.id AS ref_id, q.stem AS stem FROM questions q WHERE q.stem LIKE ? ESCAPE \'\\\' LIMIT ?',
      `%${escapeLike(q)}%`,
      limit,
    );
    return rows.map((r) => ({ refId: r.ref_id, text: r.stem }));
  }
  const rows = await db.getAllAsync<{ ref_id: string; stem: string }>(
    'SELECT ref_id, stem FROM questions_fts WHERE questions_fts MATCH ? LIMIT ?',
    q,
    limit,
  );
  return rows.map((r) => ({ refId: r.ref_id, text: r.stem }));
}

function ftsOrQuery(text: string): string {
  return buildSearchTerms(text)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/** 当前题库内的相似题（Agent 工具用；排除当前题与停用题） */
export async function searchQuestionsInBank(
  db: SQLiteDatabase,
  bankId: string,
  text: string,
  excludeId: string,
  limit = 5,
): Promise<{ id: string; stem: string }[]> {
  const q = text.trim();
  if (!q) return [];
  if (shouldUseLike(q)) {
    return db.getAllAsync<{ id: string; stem: string }>(
      `SELECT id, stem FROM questions
        WHERE bank_id = ? AND id != ? AND status != 'disabled' AND stem LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC LIMIT ?`,
      bankId,
      excludeId,
      `%${escapeLike(q)}%`,
      limit,
    );
  }
  const match = ftsOrQuery(q);
  if (!match) return [];
  return db.getAllAsync<{ id: string; stem: string }>(
    `SELECT f.ref_id AS id, f.stem
       FROM questions_fts f
       JOIN questions q ON q.id = f.ref_id
      WHERE questions_fts MATCH ? AND q.bank_id = ? AND q.id != ? AND q.status != 'disabled'
      ORDER BY bm25(questions_fts) LIMIT ?`,
    match,
    bankId,
    excludeId,
    limit,
  );
}

/** 当前题库内与题干相近的错题（Agent 工具用） */
export async function searchWrongInBank(
  db: SQLiteDatabase,
  bankId: string,
  text: string,
  excludeId: string,
  limit = 5,
): Promise<{ id: string; stem: string; wrong_count: number; last_wrong_at: string | null }[]> {
  const q = text.trim();
  if (!q) return [];
  if (shouldUseLike(q)) {
    return db.getAllAsync(
      `SELECT q.id, q.stem, w.wrong_count, w.last_wrong_at
         FROM questions q
         JOIN wrong_book w ON w.question_id = q.id
        WHERE q.bank_id = ? AND q.id != ? AND q.status != 'disabled' AND q.stem LIKE ? ESCAPE '\\'
        ORDER BY w.last_wrong_at DESC LIMIT ?`,
      bankId,
      excludeId,
      `%${escapeLike(q)}%`,
      limit,
    );
  }
  const match = ftsOrQuery(q);
  if (!match) return [];
  return db.getAllAsync(
    `SELECT f.ref_id AS id, f.stem, w.wrong_count, w.last_wrong_at
       FROM questions_fts f
       JOIN questions q ON q.id = f.ref_id
       JOIN wrong_book w ON w.question_id = q.id
      WHERE questions_fts MATCH ? AND q.bank_id = ? AND q.id != ? AND q.status != 'disabled'
      ORDER BY bm25(questions_fts) LIMIT ?`,
    match,
    bankId,
    excludeId,
    limit,
  );
}

export async function searchMaterials(db: SQLiteDatabase, query: string, limit = 5): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  if (shouldUseLike(q)) {
    const rows = await db.getAllAsync<{ ref_id: string; content: string }>(
      'SELECT ref_id, content FROM material_chunks WHERE content LIKE ? ESCAPE \'\\\' LIMIT ?',
      `%${escapeLike(q)}%`,
      limit,
    );
    return rows.map((r) => ({ refId: r.ref_id, text: r.content }));
  }
  const rows = await db.getAllAsync<{ ref_id: string; content: string }>(
    'SELECT ref_id, content FROM materials_fts WHERE materials_fts MATCH ? LIMIT ?',
    q,
    limit,
  );
  return rows.map((r) => ({ refId: r.ref_id, text: r.content }));
}

export async function indexQuestion(db: SQLiteDatabase, id: string, stem: string): Promise<void> {
  await db.runAsync('INSERT INTO questions_fts(stem, ref_id) VALUES(?, ?)', stem, id);
}

export async function indexMaterialChunk(db: SQLiteDatabase, id: string, content: string): Promise<void> {
  await db.runAsync('INSERT INTO materials_fts(content, ref_id) VALUES(?, ?)', content, id);
}

export interface MaterialHit {
  chunkId: string;
  text: string;
  sourceLoc: string | null;
  materialName: string;
}

/**
 * 教材检索（F9b）：题目文本 → 片段 OR 查询 → bm25 排序取前 N。
 * 命中不足时不凑数（返回实际命中数）；无命中返回空数组（调用方降级 F7）。
 * materialIds 传入时只在这些教材内检索（题库已绑定教材的场景）。
 */
export async function searchMaterialsSmart(
  db: SQLiteDatabase,
  questionText: string,
  limit = 5,
  materialIds?: string[],
): Promise<MaterialHit[]> {
  const terms = buildSearchTerms(questionText);
  if (terms.length === 0) return [];
  const query = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  const filter = materialIds && materialIds.length > 0
    ? ` AND c.material_id IN (${materialIds.map(() => '?').join(',')})`
    : '';
  const rows = await db.getAllAsync<{
    ref_id: string;
    content: string;
    source_loc: string | null;
    material_name: string;
  }>(
    `SELECT f.ref_id, f.content, c.source_loc, m.name AS material_name
       FROM materials_fts f
       JOIN material_chunks c ON c.id = f.ref_id
       JOIN materials m ON m.id = c.material_id
      WHERE materials_fts MATCH ?${filter}
      ORDER BY bm25(materials_fts)
      LIMIT ?`,
    query,
    ...(materialIds ?? []),
    limit,
  );
  return rows.map((r) => ({
    chunkId: r.ref_id,
    text: r.content,
    sourceLoc: r.source_loc,
    materialName: r.material_name,
  }));
}
