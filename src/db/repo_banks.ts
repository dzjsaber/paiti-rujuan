/**
 * 题库仓库层（多库）：列表（含题目数）与新建。
 * banks 表自 V1 就在（默认题库 id = bank_default），本期开放多库使用。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { newId } from '../core/ids';

export interface BankSummary {
  id: string;
  name: string;
  created_at: string;
  count: number;
}

/** 全部题库 + 题目数（空库为 0），按创建时间排序（默认题库最先） */
export async function listBanks(db: SQLiteDatabase): Promise<BankSummary[]> {
  return db.getAllAsync<BankSummary>(
    `SELECT b.id, b.name, b.created_at, COUNT(q.id) AS count
       FROM banks b LEFT JOIN questions q ON q.bank_id = b.id
      GROUP BY b.id, b.name, b.created_at
      ORDER BY b.created_at, b.id`,
  );
}

export async function createBank(db: SQLiteDatabase, name: string): Promise<string> {
  const id = newId('bank');
  await db.runAsync(
    'INSERT INTO banks(id, name, created_at) VALUES(?, ?, ?)',
    id,
    name.trim(),
    new Date().toISOString(),
  );
  return id;
}
