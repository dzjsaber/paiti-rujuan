/**
 * 多题库（banks）验证：列表计数、新建、按库刷题、全局错题、备份恢复的库兜底。
 * 用 Node 内置 sqlite 适配 expo-sqlite 的异步接口，复用真实 SQL 与仓库层代码。
 * 运行：npx tsx tests/banks.verify.ts
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { MIGRATIONS } from '../src/db/schema';
import { countAllQuestions } from '../src/db/repo_questions';
import { createBank, listBanks } from '../src/db/repo_banks';
import { countWrongBook, listPracticeQuestions, listWrongBook } from '../src/db/repo_practice';
import { restoreBackup, validateBackup, type BackupFile } from '../src/db/backup';

let passed = 0;
const fails: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    fails.push(`${name}: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 把 node:sqlite 包装成 expo-sqlite 的异步接口（只覆盖本测试用到的 5 个方法） */
function toExpoDb(sqlite: DatabaseSync): SQLiteDatabase {
  return {
    runAsync: async (sql: string, ...params: unknown[]) => {
      const r = sqlite.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    getAllAsync: async (sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).get(...(params as never[])) ?? null,
    execAsync: async (sql: string) => {
      sqlite.exec(sql);
    },
    withTransactionAsync: async (fn: () => Promise<void>) => {
      sqlite.exec('BEGIN');
      try {
        await fn();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as SQLiteDatabase;
}

function freshDb(): SQLiteDatabase {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) sqlite.exec(m.sql);
  sqlite
    .prepare('INSERT INTO banks(id, name, created_at) VALUES(?,?,?)')
    .run('bank_default', '默认题库', '2026-01-01T00:00:00.000Z');
  return toExpoDb(sqlite);
}

let qSeq = 0;
async function insertQuestionRow(db: SQLiteDatabase, bankId: string, stem: string): Promise<string> {
  qSeq += 1;
  const id = `q${qSeq}`;
  await db.runAsync(
    `INSERT INTO questions(id, bank_id, type, stem, source_engine, status, review_status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    id,
    bankId,
    'single',
    stem,
    'zhipu',
    'pending',
    'passed',
    '2026-01-02T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
  );
  return id;
}

async function main(): Promise<void> {
  await check('新建题库：出现在列表且计数为 0（按创建时间排序，默认库最前）', async () => {
    const db = freshDb();
    const id1 = await createBank(db, '第一章 单片机');
    const id2 = await createBank(db, '第二章 中断');
    assert(id1.startsWith('bank_') && id1 !== id2, '题库 id 应唯一且带 bank_ 前缀');
    const list = await listBanks(db);
    assert(list.length === 3, `应有 3 个库，实际 ${list.length}`);
    assert(list[0].id === 'bank_default', '默认题库应排最前');
    assert(list[2].name === '第二章 中断' && list[2].count === 0, '新建库名字/计数应正确');
  });

  await check('按库统计：各库题目数 + 全局总数', async () => {
    const db = freshDb();
    const b2 = await createBank(db, '库二');
    await insertQuestionRow(db, 'bank_default', '默认库题 1');
    await insertQuestionRow(db, 'bank_default', '默认库题 2');
    await insertQuestionRow(db, b2, '库二题 1');
    const list = await listBanks(db);
    assert(list.find((b) => b.id === 'bank_default')?.count === 2, '默认库应 2 题');
    assert(list.find((b) => b.id === b2)?.count === 1, '库二应 1 题');
    assert((await countAllQuestions(db)) === 3, '全局总数应为 3');
  });

  await check('按库刷题：bank 模式只取该库题目', async () => {
    const db = freshDb();
    const b2 = await createBank(db, '库二');
    await insertQuestionRow(db, 'bank_default', '默认库题 1');
    await insertQuestionRow(db, b2, '库二题 1');
    const rows = await listPracticeQuestions(db, 'bank', b2);
    assert(rows.length === 1 && rows[0].stem === '库二题 1', '应只返回库二的题');
  });

  await check('错题本全局跨库：带库名、重刷取全部库错题', async () => {
    const db = freshDb();
    const b2 = await createBank(db, '库二');
    const q1 = await insertQuestionRow(db, 'bank_default', '默认库题 1');
    const q2 = await insertQuestionRow(db, b2, '库二题 1');
    await db.runAsync(
      "INSERT INTO wrong_book(question_id, wrong_count, last_wrong_at) VALUES(?,1,'2026-01-03T00:00:00.000Z')",
      q1,
    );
    await db.runAsync(
      "INSERT INTO wrong_book(question_id, wrong_count, last_wrong_at) VALUES(?,1,'2026-01-04T00:00:00.000Z')",
      q2,
    );
    const entries = await listWrongBook(db);
    assert(entries.length === 2, `错题应跨库共 2 条，实际 ${entries.length}`);
    assert(entries[0].bank_name === '库二' && entries[1].bank_name === '默认题库', '应带库名（按最后答错时间倒序）');
    assert((await countWrongBook(db)) === 2, '全局错题计数应为 2');
    const wrongRows = await listPracticeQuestions(db, 'wrong');
    assert(wrongRows.length === 2, '错题重刷应跨库取题');
  });

  await check('恢复 v1 备份：题目引用的库不存在时兜底建库，题不丢', async () => {
    const db = freshDb();
    const v1 = validateBackup(
      JSON.stringify({
        app: 'paiti-rujuan',
        version: 1,
        exportedAt: '2026-10-16T00:00:00.000Z',
        data: {
          questions: [
            {
              id: 'q_restored',
              bank_id: 'bank_old',
              type: 'single',
              stem: '旧备份题',
              options_json: '[]',
              answer_json: '"A"',
              analysis: null,
              tags_json: '[]',
              confidence: null,
              review_reasons_json: '[]',
              visual_features_json: '[]',
              source_image_path: null,
              source_page: null,
              source_hash: null,
              question_image_path: null,
              source_engine: 'zhipu',
              status: 'pending',
              review_status: 'passed',
              created_at: '2026-01-01',
              updated_at: '2026-01-01',
            },
          ],
          wrongBook: [],
          practiceLog: [],
          settings: [],
        },
      }),
    );
    assert(v1.ok, 'v1 备份应校验通过');
    if (!v1.ok) return;
    const stats = await restoreBackup(db, v1.backup);
    assert(stats.questionsAdded === 1, '题目应入库成功');
    const list = await listBanks(db);
    assert(list.some((b) => b.id === 'bank_old'), '缺失的库应被兜底创建');
    assert((await countAllQuestions(db)) === 1, '题目应计入总数');
  });

  await check('恢复 v2 备份：题库名字与计数原样恢复', async () => {
    const db = freshDb();
    const src = freshDb();
    const b2 = await createBank(src, '第三章 定时器');
    await insertQuestionRow(src, b2, '定时器题 1');
    const questions = await src.getAllAsync<BackupFile['data']['questions'][number]>('SELECT * FROM questions');
    const banks = await src.getAllAsync<BackupFile['data']['banks'][number]>('SELECT * FROM banks');
    const backup: BackupFile = {
      app: 'paiti-rujuan',
      version: 2,
      exportedAt: '2026-10-16T00:00:00.000Z',
      counts: { questions: 1, wrongBook: 0, practiceLog: 0, settings: 0 },
      data: { banks, questions, wrongBook: [], practiceLog: [], settings: [] },
    };
    const stats = await restoreBackup(db, backup);
    assert(stats.questionsAdded === 1, '题目应入库成功');
    const list = await listBanks(db);
    const restored = list.find((b) => b.id === b2);
    assert(restored?.name === '第三章 定时器' && restored.count === 1, '库名与计数应随备份恢复');
  });

  const total = passed + fails.length;
  if (fails.length > 0) {
    console.log(`BANKS VERIFY FAILED：${passed}/${total} 通过`);
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`BANKS VERIFY PASSED：${total}/${total} 用例全部符合预期`);
}

void main();
