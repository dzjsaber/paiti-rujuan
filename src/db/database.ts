/**
 * 数据库打开与迁移执行。
 * 迁移是"要么全部成功、要么回滚"的事务单元；schema_version 记录在 meta 表。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema';

export const DEFAULT_BANK_ID = 'bank_default';

export async function migrate(db: SQLiteDatabase): Promise<number> {
  await db.execAsync('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  const current = row ? Number(row.value) : 0;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    if (m.noTransaction) {
      await db.execAsync(m.sql);
      await db.runAsync(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(m.version),
      );
    } else {
      await db.withTransactionAsync(async () => {
        await db.execAsync(m.sql);
        await db.runAsync(
          "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          String(m.version),
        );
      });
    }
  }
  return pending.length ? (pending[pending.length - 1]?.version ?? current) : current;
}

export async function openAppDatabase(db: SQLiteDatabase): Promise<SQLiteDatabase> {
  await db.execAsync('PRAGMA foreign_keys = ON');
  await migrate(db);
  // 首次打开（或用户删光了所有题库）时建默认题库；用户主动删除默认题库后不复活
  const c = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM banks');
  if ((c?.c ?? 0) === 0) {
    await db.runAsync(
      'INSERT INTO banks(id, name, created_at) VALUES(?, ?, ?)',
      DEFAULT_BANK_ID,
      '默认题库',
      new Date().toISOString(),
    );
  }
  return db;
}

export { LATEST_SCHEMA_VERSION };
