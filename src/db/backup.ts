/**
 * F6 数据备份与恢复：
 * - 版本化 JSON：题库、错题本、做题记录、设置；
 * - 不包含图片与教材原文件（JSON 仅存路径、跨设备无效），UI 必须明确说明；
 * - 恢复按稳定 ID 合并（已存在的题目/记录自动跳过），整个恢复在单事务内完成，
 *   中途失败自动回滚，不留半恢复数据；
 * - 导入前做大小/结构/版本校验，拒绝不可信备份。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QuestionRow } from './repo_questions';
import { indexQuestion } from './fts';

export const BACKUP_VERSION = 2;
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export interface BackupBankRow {
  id: string;
  name: string;
  created_at: string;
}

export interface BackupWrongBookRow {
  question_id: string;
  wrong_count: number;
  last_wrong_at: string | null;
}

export interface BackupPracticeLogRow {
  question_id: string;
  is_correct: number | null;
  answered_at: string;
}

export interface BackupFile {
  app: 'paiti-rujuan';
  version: number;
  exportedAt: string;
  counts: { questions: number; wrongBook: number; practiceLog: number; settings: number };
  data: {
    /** v2 起包含题库（名字随备份走，避免恢复后只剩 id） */
    banks: BackupBankRow[];
    questions: QuestionRow[];
    wrongBook: BackupWrongBookRow[];
    practiceLog: BackupPracticeLogRow[];
    settings: { key: string; value: string }[];
  };
}

export async function buildBackup(db: SQLiteDatabase): Promise<BackupFile> {
  const banks = await db.getAllAsync<BackupBankRow>('SELECT id, name, created_at FROM banks ORDER BY created_at, id');
  const questions = await db.getAllAsync<QuestionRow>('SELECT * FROM questions ORDER BY created_at, id');
  const wrongBook = await db.getAllAsync<BackupWrongBookRow>('SELECT * FROM wrong_book');
  const practiceLog = await db.getAllAsync<BackupPracticeLogRow>('SELECT * FROM practice_log');
  const settings = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings');
  return {
    app: 'paiti-rujuan',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      questions: questions.length,
      wrongBook: wrongBook.length,
      practiceLog: practiceLog.length,
      settings: settings.length,
    },
    data: { banks, questions, wrongBook, practiceLog, settings },
  };
}

export type BackupValidation = { ok: true; backup: BackupFile } | { ok: false; error: string };

export function validateBackup(text: string): BackupValidation {
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, error: '备份文件过大（超过 20MB），已拒绝' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是有效的 JSON 文件' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '备份结构无效' };
  }
  const b = parsed as Partial<BackupFile>;
  if (b.app !== 'paiti-rujuan') return { ok: false, error: '不是本应用的备份文件' };
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) {
    return { ok: false, error: `备份版本不支持（v${String(b.version)}）` };
  }
  const d = b.data as BackupFile['data'] | undefined;
  if (!d || !Array.isArray(d.questions) || !Array.isArray(d.wrongBook) || !Array.isArray(d.practiceLog)) {
    return { ok: false, error: '备份数据缺失或结构错误' };
  }
  // 抽查题目关键字段（大文件全量校验过慢；恢复时对单条异常容错跳过）
  for (const q of d.questions.slice(0, 100)) {
    const o = q as unknown as Record<string, unknown>;
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || typeof o.stem !== 'string') {
      return { ok: false, error: '题目数据字段缺失，备份可能已损坏' };
    }
  }
  if (!Array.isArray(d.settings)) d.settings = [];
  // v1 备份没有 banks：恢复时按题目引用的 bank_id 兜底建库
  if (!Array.isArray(d.banks)) d.banks = [];
  return {
    ok: true,
    backup: {
      app: 'paiti-rujuan',
      version: b.version,
      exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : '',
      counts: b.counts ?? { questions: d.questions.length, wrongBook: d.wrongBook.length, practiceLog: d.practiceLog.length, settings: d.settings.length },
      data: d,
    },
  };
}

/** QuestionRow → INSERT 参数（与 repo_questions 的 INSERT_SQL 列序一致） */
export function questionRowToParams(q: QuestionRow): (string | number | null)[] {
  return [
    q.id,
    q.bank_id,
    q.type,
    q.stem,
    q.options_json,
    q.answer_json,
    q.analysis,
    q.tags_json,
    q.confidence,
    q.review_reasons_json,
    q.visual_features_json,
    q.source_image_path,
    q.source_page,
    q.source_hash,
    q.question_image_path,
    q.source_engine,
    q.status,
    q.review_status,
    q.created_at,
    q.updated_at,
    q.ai_explanation ?? null,
    q.favorite ?? 0,
  ];
}

const RESTORE_INSERT_SQL = `INSERT OR IGNORE INTO questions(
  id, bank_id, type, stem, options_json, answer_json, analysis, tags_json, confidence,
  review_reasons_json, visual_features_json, source_image_path, source_page, source_hash,
  question_image_path, source_engine, status, review_status, created_at, updated_at, ai_explanation, favorite
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export interface RestoreStats {
  questionsAdded: number;
  questionsSkipped: number;
  logsAdded: number;
  logsSkipped: number;
  wrongMerged: number;
  settingsApplied: number;
}

export async function restoreBackup(db: SQLiteDatabase, backup: BackupFile): Promise<RestoreStats> {
  const stats: RestoreStats = {
    questionsAdded: 0,
    questionsSkipped: 0,
    logsAdded: 0,
    logsSkipped: 0,
    wrongMerged: 0,
    settingsApplied: 0,
  };
  await db.withTransactionAsync(async () => {
    const knownBankIds = new Set<string>();
    for (const b of backup.data.banks ?? []) {
      try {
        if (!b || typeof b.id !== 'string') continue;
        await db.runAsync(
          'INSERT OR IGNORE INTO banks(id, name, created_at) VALUES(?,?,?)',
          b.id,
          typeof b.name === 'string' && b.name.trim() ? b.name : '恢复题库',
          typeof b.created_at === 'string' ? b.created_at : new Date().toISOString(),
        );
        knownBankIds.add(b.id);
      } catch {
        /* 单条异常跳过 */
      }
    }
    for (const q of backup.data.questions) {
      try {
        // v1 备份或缺 banks 的备份：题目引用的库不存在时兜底建库（否则外键失败丢题）
        if (q.bank_id && !knownBankIds.has(q.bank_id)) {
          await db.runAsync(
            'INSERT OR IGNORE INTO banks(id, name, created_at) VALUES(?,?,?)',
            q.bank_id,
            q.bank_id === 'bank_default' ? '默认题库' : '恢复题库',
            new Date().toISOString(),
          );
          knownBankIds.add(q.bank_id);
        }
        const params = questionRowToParams(q);
        const res = await db.runAsync(RESTORE_INSERT_SQL, ...params);
        if (res.changes > 0) {
          stats.questionsAdded += 1;
          await indexQuestion(db, q.id, q.stem);
        } else {
          stats.questionsSkipped += 1;
        }
      } catch {
        stats.questionsSkipped += 1;
      }
    }
    for (const w of backup.data.wrongBook) {
      try {
        const res = await db.runAsync(
          'INSERT OR IGNORE INTO wrong_book(question_id, wrong_count, last_wrong_at) VALUES(?,?,?)',
          w.question_id,
          typeof w.wrong_count === 'number' ? w.wrong_count : 0,
          w.last_wrong_at ?? null,
        );
        if (res.changes > 0) stats.wrongMerged += 1;
      } catch {
        /* 单条异常跳过 */
      }
    }
    for (const l of backup.data.practiceLog) {
      try {
        const exists = await db.getFirstAsync(
          'SELECT 1 FROM practice_log WHERE question_id = ? AND answered_at = ? LIMIT 1',
          l.question_id,
          l.answered_at,
        );
        if (exists) {
          stats.logsSkipped += 1;
          continue;
        }
        await db.runAsync(
          'INSERT INTO practice_log(question_id, is_correct, answered_at) VALUES(?,?,?)',
          l.question_id,
          typeof l.is_correct === 'number' ? l.is_correct : null,
          l.answered_at,
        );
        stats.logsAdded += 1;
      } catch {
        stats.logsSkipped += 1;
      }
    }
    for (const s of backup.data.settings) {
      try {
        const res = await db.runAsync('INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)', s.key, s.value);
        if (res.changes > 0) stats.settingsApplied += 1;
      } catch {
        /* 单条异常跳过 */
      }
    }
  });
  return stats;
}
