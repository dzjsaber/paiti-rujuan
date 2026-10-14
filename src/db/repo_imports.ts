/**
 * 导入任务持久化层（§3.3）：批次 / 页面 / 草稿项。
 * 每次编辑、复核、确认、丢弃都要及时落库（禁止只依赖内存状态）。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ImportBatchStatus, ImportItemStatus, ImportPageStatus, ImportSourceType, QuestionDraft } from '../core/models';
import { newId } from '../core/ids';

export interface ImportBatchRow {
  id: string;
  status: ImportBatchStatus;
  source_type: ImportSourceType;
  created_at: string;
  updated_at: string;
  error_summary: string | null;
}

export interface ImportPageRow {
  id: string;
  batch_id: string;
  status: ImportPageStatus;
  image_path: string | null;
  page_no: number | null;
  attempt: number;
  error_type: string | null;
  updated_at: string;
}

export interface ImportItemRow {
  id: string;
  batch_id: string;
  page_id: string;
  status: ImportItemStatus;
  draft_json: string;
  raw_summary: string | null;
  edited: number;
  updated_at: string;
}

export async function createBatch(db: SQLiteDatabase, sourceType: ImportSourceType): Promise<string> {
  const id = newId('batch');
  const now = new Date().toISOString();
  await db.runAsync(
    'INSERT INTO import_batches(id, status, source_type, created_at, updated_at) VALUES(?, ?, ?, ?, ?)',
    id,
    'running',
    sourceType,
    now,
    now,
  );
  return id;
}

export async function updateBatchStatus(
  db: SQLiteDatabase,
  batchId: string,
  status: ImportBatchStatus,
  errorSummary?: string | null,
): Promise<void> {
  await db.runAsync(
    'UPDATE import_batches SET status = ?, error_summary = ?, updated_at = ? WHERE id = ?',
    status,
    errorSummary ?? null,
    new Date().toISOString(),
    batchId,
  );
}

export async function createPage(
  db: SQLiteDatabase,
  batchId: string,
  imagePath: string | null,
  pageNo: number | null,
): Promise<string> {
  const id = newId('page');
  await db.runAsync(
    'INSERT INTO import_pages(id, batch_id, status, image_path, page_no, attempt, updated_at) VALUES(?, ?, ?, ?, ?, 0, ?)',
    id,
    batchId,
    'queued',
    imagePath,
    pageNo,
    new Date().toISOString(),
  );
  return id;
}

export async function updatePageStatus(
  db: SQLiteDatabase,
  pageId: string,
  status: ImportPageStatus,
  errorType?: string | null,
  incrementAttempt = false,
): Promise<void> {
  await db.runAsync(
    'UPDATE import_pages SET status = ?, error_type = ?, attempt = attempt + ?, updated_at = ? WHERE id = ?',
    status,
    errorType ?? null,
    incrementAttempt ? 1 : 0,
    new Date().toISOString(),
    pageId,
  );
}

/** 保存一批草稿（新识别结果落库）；返回写入的 item id 列表 */
export async function saveDraftItems(
  db: SQLiteDatabase,
  batchId: string,
  pageId: string,
  drafts: QuestionDraft[],
  itemStatus: ImportItemStatus = 'draft',
  rawSummary?: string | null,
): Promise<string[]> {
  const ids: string[] = [];
  const now = new Date().toISOString();
  for (const d of drafts) {
    const id = newId('item');
    ids.push(id);
    await db.runAsync(
      'INSERT INTO import_items(id, batch_id, page_id, status, draft_json, raw_summary, edited, updated_at) VALUES(?, ?, ?, ?, ?, ?, 0, ?)',
      id,
      batchId,
      pageId,
      itemStatus,
      JSON.stringify(d),
      rawSummary ? rawSummary.slice(0, 2000) : null,
      now,
    );
  }
  return ids;
}

export async function updateItemDraft(
  db: SQLiteDatabase,
  itemId: string,
  draft: QuestionDraft,
  status?: ImportItemStatus,
): Promise<void> {
  await db.runAsync(
    'UPDATE import_items SET draft_json = ?, status = COALESCE(?, status), edited = 1, updated_at = ? WHERE id = ?',
    JSON.stringify(draft),
    status ?? null,
    new Date().toISOString(),
    itemId,
  );
}

export async function setItemStatus(db: SQLiteDatabase, itemId: string, status: ImportItemStatus): Promise<void> {
  await db.runAsync('UPDATE import_items SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), itemId);
}

export function rowToDraft(row: ImportItemRow): QuestionDraft {
  return JSON.parse(row.draft_json) as QuestionDraft;
}

export async function getItemsByBatch(db: SQLiteDatabase, batchId: string): Promise<ImportItemRow[]> {
  return db.getAllAsync<ImportItemRow>('SELECT * FROM import_items WHERE batch_id = ? ORDER BY updated_at, id', batchId);
}

export async function getPagesByBatch(db: SQLiteDatabase, batchId: string): Promise<ImportPageRow[]> {
  return db.getAllAsync<ImportPageRow>('SELECT * FROM import_pages WHERE batch_id = ? ORDER BY page_no, id', batchId);
}

export async function getUnfinishedBatches(db: SQLiteDatabase): Promise<ImportBatchRow[]> {
  return db.getAllAsync<ImportBatchRow>(
    "SELECT * FROM import_batches WHERE status IN ('queued','running','paused') ORDER BY created_at DESC",
  );
}
