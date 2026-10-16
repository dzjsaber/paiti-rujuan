/**
 * 题库仓库层（多库）：列表（含题目数）、新建/重命名/删除、教材绑定。
 * banks 表自 V1 就在（默认题库 id = bank_default），本期开放多库使用。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { newId } from '../core/ids';

export interface BankSummary {
  id: string;
  name: string;
  created_at: string;
  count: number;
  /** 收藏题数量（"只刷收藏"入口显示；不含停用题） */
  fav_count: number;
}

/** 全部题库 + 题目数/收藏数（空库为 0），按创建时间排序（默认题库最先） */
export async function listBanks(db: SQLiteDatabase): Promise<BankSummary[]> {
  return db.getAllAsync<BankSummary>(
    `SELECT b.id, b.name, b.created_at, COUNT(q.id) AS count,
            COALESCE(SUM(CASE WHEN q.favorite = 1 AND q.status != 'disabled' THEN 1 ELSE 0 END), 0) AS fav_count
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

export async function renameBank(db: SQLiteDatabase, id: string, name: string): Promise<void> {
  await db.runAsync('UPDATE banks SET name = ? WHERE id = ?', name.trim(), id);
}

/**
 * 删除题库：题目随外键级联（连同错题本、做题记录、教材绑定）；
 * questions_fts 非外键表，需先按库内题目清理（应用层维护索引的既有约定）。
 */
export async function deleteBank(db: SQLiteDatabase, id: string): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM questions_fts WHERE ref_id IN (SELECT id FROM questions WHERE bank_id = ?)', id);
    await db.runAsync('DELETE FROM banks WHERE id = ?', id);
  });
}

export async function listBankMaterialIds(db: SQLiteDatabase, bankId: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ material_id: string }>(
    'SELECT material_id FROM bank_materials WHERE bank_id = ? ORDER BY created_at, material_id',
    bankId,
  );
  return rows.map((r) => r.material_id);
}

/** 全量替换题库的教材绑定（弹层保存语义） */
export async function setBankMaterials(
  db: SQLiteDatabase,
  bankId: string,
  materialIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM bank_materials WHERE bank_id = ?', bankId);
    for (const mid of materialIds) {
      await db.runAsync(
        'INSERT OR IGNORE INTO bank_materials(bank_id, material_id, created_at) VALUES(?,?,?)',
        bankId,
        mid,
        now,
      );
    }
  });
}
