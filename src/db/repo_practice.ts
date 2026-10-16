/**
 * 练习与错题本持久化（F4/F5）。
 * 规则（§F4/F5）：
 * - 每次判定后写入 practice_log；
 * - 答错 → wrong_book 计数 +1（任何模式）；
 * - 错题本模式重刷答对 → 移出错题本（历史 practice_log 保留）；
 * - 停用（disabled）题目自动排除在错题本与刷题之外；删除题目级联清理。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QuestionRow } from './repo_questions';
import { newId } from '../core/ids';

export interface WrongBookEntry {
  question_id: string;
  wrong_count: number;
  last_wrong_at: string | null;
  stem: string;
  type: string;
  answer_json: string;
  options_json: string;
  source_image_path: string | null;
  status: string;
  bank_name: string;
}

export async function recordAnswer(db: SQLiteDatabase, questionId: string, isCorrect: boolean): Promise<void> {
  await db.runAsync(
    'INSERT INTO practice_log(question_id, is_correct, answered_at) VALUES(?, ?, ?)',
    questionId,
    isCorrect ? 1 : 0,
    new Date().toISOString(),
  );
}

export async function markWrong(db: SQLiteDatabase, questionId: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO wrong_book(question_id, wrong_count, last_wrong_at) VALUES(?, 1, ?)
     ON CONFLICT(question_id) DO UPDATE SET wrong_count = wrong_count + 1, last_wrong_at = excluded.last_wrong_at`,
    questionId,
    new Date().toISOString(),
  );
}

export async function removeFromWrongBook(db: SQLiteDatabase, questionId: string): Promise<void> {
  await db.runAsync('DELETE FROM wrong_book WHERE question_id = ?', questionId);
}

/** 错题本全局跨库（条目上标注所属库名） */
export async function listWrongBook(db: SQLiteDatabase): Promise<WrongBookEntry[]> {
  return db.getAllAsync<WrongBookEntry>(
    `SELECT w.question_id, w.wrong_count, w.last_wrong_at,
            q.stem, q.type, q.answer_json, q.options_json, q.source_image_path, q.status,
            b.name AS bank_name
       FROM wrong_book w
       JOIN questions q ON q.id = w.question_id
       JOIN banks b ON b.id = q.bank_id
      WHERE q.status != 'disabled'
      ORDER BY w.last_wrong_at DESC`,
  );
}

export async function countWrongBook(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM wrong_book w JOIN questions q ON q.id = w.question_id
      WHERE q.status != 'disabled'`,
  );
  return row?.c ?? 0;
}

/**
 * 刷题题目来源：bank = 指定题库全部非停用题；fav = 指定题库的收藏题；
 * wrong = 全部题库的错题（跨库）。
 */
export async function listPracticeQuestions(
  db: SQLiteDatabase,
  mode: 'bank' | 'wrong' | 'fav',
  bankId?: string,
  limit = 500,
): Promise<QuestionRow[]> {
  if (mode === 'wrong') {
    return db.getAllAsync<QuestionRow>(
      `SELECT q.* FROM questions q JOIN wrong_book w ON w.question_id = q.id
        WHERE q.status != 'disabled'
        ORDER BY w.last_wrong_at DESC LIMIT ?`,
      limit,
    );
  }
  if (mode === 'fav') {
    return db.getAllAsync<QuestionRow>(
      "SELECT * FROM questions WHERE bank_id = ? AND favorite = 1 AND status != 'disabled' ORDER BY created_at, id LIMIT ?",
      bankId ?? '',
      limit,
    );
  }
  return db.getAllAsync<QuestionRow>(
    "SELECT * FROM questions WHERE bank_id = ? AND status != 'disabled' ORDER BY created_at, id LIMIT ?",
    bankId ?? '',
    limit,
  );
}

/** 题库内收藏题数量（库选择页显示） */
export async function countFavorite(db: SQLiteDatabase, bankId: string): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    "SELECT COUNT(*) AS c FROM questions WHERE bank_id = ? AND favorite = 1 AND status != 'disabled'",
    bankId,
  );
  return row?.c ?? 0;
}

export function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** AI 讲解"反馈有误"本地记录（F7） */
export async function recordAiFeedback(
  db: SQLiteDatabase,
  questionId: string,
  kind = 'explain_wrong',
): Promise<void> {
  await db.runAsync(
    'INSERT INTO ai_feedback(id, question_id, kind, created_at) VALUES(?,?,?,?)',
    newId('fb'),
    questionId,
    kind,
    new Date().toISOString(),
  );
}
