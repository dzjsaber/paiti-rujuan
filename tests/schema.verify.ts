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

  await check('迁移幂等（版本机制下重复运行无错）', () => {
    // 模拟真实迁移逻辑（database.ts）：按 schema_version 只执行未应用的迁移
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const runMigrations = () => {
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
        | { value: string }
        | undefined;
      const current = row ? Number(row.value) : 0;
      for (const m of MIGRATIONS.filter((x) => x.version > current).sort((a, b) => a.version - b.version)) {
        db.exec(m.sql);
        db.prepare(
          "INSERT INTO meta(key,value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(String(m.version));
      }
    };
    runMigrations();
    runMigrations(); // 第二次应全部跳过（ALTER TABLE 不得重复执行）
    const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
    const latest = String(MIGRATIONS[MIGRATIONS.length - 1].version);
    if (v.value !== latest) throw new Error(`schema_version 应为 ${latest}，实际 ${v.value}`);
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
    // v8 起支持 fill（填空/简答）
    db.exec(
      "INSERT INTO questions(id,bank_id,type,stem,source_engine,status,review_status,created_at,updated_at) " +
        "VALUES('q3','b1','fill','填空题____','zhipu','pending','passed','2026-01-01','2026-01-01')",
    );
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

  await check('V3 迁移：import_batches 重建（数据保留 + pptx 枚举 + 级联仍然有效）', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of MIGRATIONS.filter((x) => x.version <= 2)) db.exec(m.sql);
    db.exec("INSERT INTO import_batches(id,status,source_type,created_at,updated_at) VALUES('b1','completed','photo','2026-01-01','2026-01-01')");
    db.exec("INSERT INTO import_pages(id,batch_id,status,updated_at) VALUES('p1','b1','completed','2026-01-01')");
    const v3 = MIGRATIONS.find((x) => x.version === 3);
    if (!v3) throw new Error('缺少 V3 迁移');
    db.exec(v3.sql);
    const b = db.prepare("SELECT source_type FROM import_batches WHERE id='b1'").get() as { source_type: string };
    if (b.source_type !== 'photo') throw new Error('旧数据应保留');
    db.exec("INSERT INTO import_batches(id,status,source_type,created_at,updated_at) VALUES('b2','running','pptx','2026-01-01','2026-01-01')");
    let threw = false;
    try {
      db.exec("INSERT INTO import_batches(id,status,source_type,created_at,updated_at) VALUES('b3','running','bogus','2026-01-01','2026-01-01')");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('非法 source_type 应被 CHECK 拒绝');
    db.exec("DELETE FROM import_batches WHERE id='b1'");
    const p = db.prepare('SELECT COUNT(*) AS c FROM import_pages').get() as { c: number };
    if (p.c !== 0) throw new Error('删除批次后页面应级联删除');
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
