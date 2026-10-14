/**
 * 离线验证数据库 Schema：用 Node 内置 sqlite（node:sqlite）执行真实 DDL，
 * 检查建表、FTS5 trigram、CHECK 约束、外键级联与迁移幂等。
 * 注意：node:sqlite 与 expo-sqlite 不是同一构建，本脚本只覆盖 SQL 语法与语义；
 * expo-sqlite 真机行为（SQLite 3.50.3）已在 M1-A 自检页验证。
 * 运行：npx tsx tests/schema.verify.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/db/schema';

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
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) db.exec(m.sql);
  return db;
}

async function main(): Promise<void> {
  await check('全部迁移可执行（含 FTS5 trigram）', () => {
    freshDb();
  });

  await check('迁移幂等（重复执行无错）', () => {
    const db = freshDb();
    for (const m of MIGRATIONS) db.exec(m.sql);
  });

  await check('FTS5 trigram：3 字命中 / 2 字无命中（与真机一致）', () => {
    const db = freshDb();
    db.exec("INSERT INTO questions_fts(stem, ref_id) VALUES('细胞膜的流动镶嵌模型','q1')");
    const c1 = db.prepare('SELECT COUNT(*) AS c FROM questions_fts WHERE questions_fts MATCH ?').get('细胞膜') as { c: number };
    assert(c1.c === 1, 'trigram MATCH「细胞膜」应命中 1 条');
    const c2 = db.prepare('SELECT COUNT(*) AS c FROM questions_fts WHERE questions_fts MATCH ?').get('细胞') as { c: number };
    assert(c2.c === 0, 'trigram MATCH「细胞」应为 0 条（需 LIKE 回退）');
  });

  await check('CHECK 约束：非法 status / 非法 type 被拒绝', () => {
    const db = freshDb();
    db.exec("INSERT INTO banks(id,name,created_at) VALUES('b1','默认','2026-01-01')");
    let threw = false;
    try {
      db.exec(
        "INSERT INTO questions(id,bank_id,type,stem,source_engine,status,review_status,created_at,updated_at) " +
          "VALUES('q1','b1','single','题干','zhipu','bogus','passed','2026-01-01','2026-01-01')",
      );
    } catch {
      threw = true;
    }
    assert(threw, '非法 status 应被 CHECK 拒绝');
    let threw2 = false;
    try {
      db.exec(
        "INSERT INTO questions(id,bank_id,type,stem,source_engine,status,review_status,created_at,updated_at) " +
          "VALUES('q2','b1','解答','题干','zhipu','pending','passed','2026-01-01','2026-01-01')",
      );
    } catch {
      threw2 = true;
    }
    assert(threw2, '枚举外 type 应被 CHECK 拒绝');
  });

  await check('source_hash 唯一约束', () => {
    const db = freshDb();
    db.exec("INSERT INTO banks(id,name,created_at) VALUES('b1','默认','2026-01-01')");
    const ins = (id: string) =>
      db.exec(
        `INSERT INTO questions(id,bank_id,type,stem,source_hash,source_engine,status,review_status,created_at,updated_at) ` +
          `VALUES('${id}','b1','single','题干','H1','zhipu','pending','passed','2026-01-01','2026-01-01')`,
      );
    ins('q1');
    let threw = false;
    try {
      ins('q2');
    } catch {
      threw = true;
    }
    assert(threw, '相同 source_hash 的第二条应被拒绝');
  });

  await check('级联删除：删批次 → 级联草稿项与页面', () => {
    const db = freshDb();
    db.exec("INSERT INTO import_batches(id,status,source_type,created_at,updated_at) VALUES('ba1','running','photo','2026-01-01','2026-01-01')");
    db.exec("INSERT INTO import_pages(id,batch_id,status,updated_at) VALUES('p1','ba1','queued','2026-01-01')");
    db.exec("INSERT INTO import_items(id,batch_id,page_id,status,draft_json,updated_at) VALUES('i1','ba1','p1','draft','{}','2026-01-01')");
    db.exec("DELETE FROM import_batches WHERE id='ba1'");
    const items = db.prepare('SELECT COUNT(*) AS c FROM import_items').get() as { c: number };
    const pages = db.prepare('SELECT COUNT(*) AS c FROM import_pages').get() as { c: number };
    assert(items.c === 0, '草稿项应被级联删除');
    assert(pages.c === 0, '页面应被级联删除');
  });

  await check('级联删除：删题目 → 错题本与做题记录一并清理', () => {
    const db = freshDb();
    db.exec("INSERT INTO banks(id,name,created_at) VALUES('b1','默认','2026-01-01')");
    db.exec("INSERT INTO questions(id,bank_id,type,stem,source_engine,status,review_status,created_at,updated_at) VALUES('q1','b1','single','题干','zhipu','pending','passed','2026-01-01','2026-01-01')");
    db.exec("INSERT INTO wrong_book(question_id,wrong_count) VALUES('q1',2)");
    db.exec("INSERT INTO practice_log(question_id,is_correct,answered_at) VALUES('q1',0,'2026-01-01')");
    db.exec("DELETE FROM questions WHERE id='q1'");
    const wb = db.prepare('SELECT COUNT(*) AS c FROM wrong_book').get() as { c: number };
    const pl = db.prepare('SELECT COUNT(*) AS c FROM practice_log').get() as { c: number };
    assert(wb.c === 0 && pl.c === 0, '错题本与做题记录应级联清理');
  });

  const total = passed + fails.length;
  if (fails.length > 0) {
    console.log(`SCHEMA VERIFY FAILED：${passed}/${total} 通过`);
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`SCHEMA VERIFY PASSED：${total}/${total} 用例全部符合预期`);
}

void main();
