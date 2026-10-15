/**
 * 数据库 Schema 与版本迁移（§3.3）。
 * 规则：
 * - 所有表结构变更都必须新增 migration，禁止改历史 migration；
 * - SQL 全部使用参数化查询（本文件只含 DDL 常量）；
 * - FTS5 使用独立索引表（非 external content），由应用层保持同步。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** 需要在事务外执行（如涉及 PRAGMA foreign_keys 的表重建） */
  noTransaction?: boolean;
}

const V1_SQL = `
-- 元信息（schema 版本等）
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 题库分组（一期只有默认题库，UI 不提供建库/切换）
CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 题目主表
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('single','multiple','judge')),
  stem TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  answer_json TEXT NOT NULL DEFAULT 'null',
  analysis TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  review_reasons_json TEXT NOT NULL DEFAULT '[]',
  visual_features_json TEXT NOT NULL DEFAULT '[]',
  source_image_path TEXT,
  source_page INTEGER,
  source_hash TEXT,
  source_engine TEXT NOT NULL CHECK (source_engine IN ('zhipu','doc')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','disabled')),
  review_status TEXT NOT NULL CHECK (review_status IN ('passed','needs_review','invalid')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_bank ON questions(bank_id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_source_hash
  ON questions(source_hash) WHERE source_hash IS NOT NULL;

-- 错题本
CREATE TABLE IF NOT EXISTS wrong_book (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  last_wrong_at TEXT
);

-- 做题记录
CREATE TABLE IF NOT EXISTS practice_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  is_correct INTEGER,
  answered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_practice_question ON practice_log(question_id);

-- 教材与分块
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_path TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS material_chunks (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source_loc TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_material ON material_chunks(material_id);

-- 设置（非秘密配置；API Key 不存于此表）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 导入任务：批次 / 页面 / 草稿项（草稿生命周期与正式题目状态严格分离）
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','completed','completed_with_errors','cancelled')),
  source_type TEXT NOT NULL CHECK (source_type IN ('photo','gallery','pdf','docx','txt','md')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_summary TEXT
);
CREATE TABLE IF NOT EXISTS import_pages (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','recognized','failed','needs_review','completed','cancelled')),
  image_path TEXT,
  page_no INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_batch ON import_pages(batch_id);
CREATE TABLE IF NOT EXISTS import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES import_pages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('draft','needs_review','approved_for_insert','inserted','discarded')),
  draft_json TEXT NOT NULL,
  raw_summary TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_batch ON import_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_items_page ON import_items(page_id);

-- 检索索引（trigram；短于 3 字符的查询由应用层走 LIKE 回退——真机已验证）
CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(stem, ref_id UNINDEXED, tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS materials_fts USING fts5(content, ref_id UNINDEXED, tokenize='trigram');
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: '001_init', sql: V1_SQL },
  {
    version: 2,
    name: '002_question_image',
    // 题目配图：图形类题干/选项无法用文字表达时，用户可从原图裁切保存为本题配图
    sql: 'ALTER TABLE questions ADD COLUMN question_image_path TEXT;',
  },
  {
    version: 3,
    name: '003_import_source_pptx',
    // source_type 增加 pptx：SQLite 无法直接修改 CHECK，按官方推荐流程重建表
    // （新建 → 复制 → 删除 → 改名）；PRAGMA 必须在事务外，故 noTransaction。
    noTransaction: true,
    sql: `
PRAGMA foreign_keys = OFF;
DROP TABLE IF EXISTS import_batches_new;
CREATE TABLE import_batches_new (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','completed','completed_with_errors','cancelled')),
  source_type TEXT NOT NULL CHECK (source_type IN ('photo','gallery','pdf','docx','pptx','txt','md')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_summary TEXT
);
INSERT INTO import_batches_new(id, status, source_type, created_at, updated_at, error_summary)
  SELECT id, status, source_type, created_at, updated_at, error_summary FROM import_batches;
DROP TABLE import_batches;
ALTER TABLE import_batches_new RENAME TO import_batches;
PRAGMA foreign_keys = ON;
`,
  },
  {
    version: 4,
    name: '004_material_images',
    // 教材内嵌图片（PPT/PPTX 按页提取）：文件存应用私有目录，表里记路径
    sql: `CREATE TABLE IF NOT EXISTS material_images (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  page_no INTEGER,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_material_images ON material_images(material_id);`,
  },
  {
    version: 5,
    name: '005_ai_feedback',
    // AI 讲解的"反馈有误"本地记录（F7）
    sql: `CREATE TABLE IF NOT EXISTS ai_feedback (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
