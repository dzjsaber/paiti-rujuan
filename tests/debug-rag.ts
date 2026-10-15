/**
 * 临时调试：教材检索命中率（用真实课件 + 模拟题目验证 RAG 检索质量）。
 * 用法：npx tsx tests/debug-rag.ts "<教材文件.ppt|.pptx|.txt...>"
 */
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { buildSearchTerms, clipHitText } from '../src/core/searchTerms';
import { searchMaterialsSmart } from '../src/db/fts';
import { MIGRATIONS } from '../src/db/schema';
import { MATERIAL_BOUNDARY, chunkDocument } from '../src/services/documents/chunker';
import { pptBytesToText } from '../src/services/documents/ppt';
import { pptxBytesToTextAndImages } from '../src/services/documents/pptx';

const file = process.argv[2];
if (!file) {
  console.log('用法: npx tsx tests/debug-rag.ts <教材文件>');
  process.exit(1);
}

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

// 模拟用户题库中"教材里确实有答案"的题目（expect = 教材中回答该题的原文片段）
const QUESTIONS = [
  { q: '8051单片机复位后，程序计数器PC的值是（ ）', expect: '0000H' },
  { q: '8051单片机共有多少个中断源？（ ）', expect: '中断源有5个' },
  { q: '8051单片机内部集成了几个16位定时器/计数器？（ ）', expect: '集成了2个' },
  { q: '8051单片机在存储器的配置上采用什么结构？（ ）', expect: '哈福' },
  { q: '8051单片机共有多少条指令？（ ）', expect: '111条指令' },
  { q: '8051单片机的并行I/O口共有几个？（ ）', expect: '4个双向并行' },
  { q: '下列芯片中，属于ROM型8051典型芯片的是（ ）', expect: '89C51' },
  { q: '8051单片机中断源分为几个优先级？（ ）', expect: '2个优先级' },
];

async function main(): Promise<void> {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const extracted = file.toLowerCase().endsWith('.pptx')
    ? pptxBytesToTextAndImages(bytes)
    : pptBytesToText(bytes);
  if (process.argv[3] === '--dump') {
    console.log(extracted.text);
    return;
  }
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) sqlite.exec(m.sql);
  const db = toExpoDb(sqlite);

  const chunks = chunkDocument(extracted.text, 800, 100, MATERIAL_BOUNDARY);
  const now = new Date().toISOString();
  await db.runAsync("INSERT INTO materials(id,name,file_path,created_at) VALUES('m1','测试教材',NULL,?)", now);
  let n = 0;
  for (const c of chunks) {
    n += 1;
    const cid = `c${n}`;
    await db.runAsync(
      'INSERT INTO material_chunks(id,material_id,content,source_loc,created_at) VALUES(?,?,?,?,?)',
      cid,
      'm1',
      c.text,
      `字符 ${c.charStart}-${c.charEnd}`,
      now,
    );
    await db.runAsync('INSERT INTO materials_fts(content,ref_id) VALUES(?,?)', c.text, cid);
  }
  console.log(`教材：${file}`);
  console.log(`提取 ${extracted.text.length} 字符 · 分块 ${chunks.length} 段\n`);

  let hitCount = 0;
  let rightCount = 0;
  for (const { q, expect } of QUESTIONS) {
    const searchText = `${q}\n（判断题）`;
    const terms = buildSearchTerms(searchText);
    const hits = await searchMaterialsSmart(db, q, 20);
    if (hits.length > 0) hitCount += 1;
    const rightAt = hits.findIndex((h) => h.text.includes(expect));
    const rightClipAt = hits.findIndex((h) => clipHitText(h.text, terms).includes(expect));
    if (rightAt >= 0) rightCount += 1;
    console.log('--------------------------------------------');
    console.log('题目：', q);
    console.log('检索词：', terms.join(' | '));
    console.log(
      `命中：${hits.length} · 正确段落：${rightAt >= 0 ? `第 ${rightAt + 1} 条` : '未命中'}` +
        ` · 前 300 字内：${rightClipAt >= 0 ? `第 ${rightClipAt + 1} 条` : '否'}`,
    );
    const evLen = hits.slice(0, 10).reduce((n, h) => n + clipHitText(h.text, terms).length, 0);
    console.log(`  证据总量（top10 窗口）：约 ${evLen} 字`);
    if (rightAt >= 0 && rightClipAt < 0) {
      const h = hits[rightAt];
      const clip = clipHitText(h.text, terms);
      console.log(
        `  [诊断] 正确段落 ${h.text.length} 字，答案位于 ${h.text.indexOf(expect)} 字处；clip 含答案：${clip.includes(expect)}`,
      );
    }
    hits.slice(0, 3).forEach((h, i) => {
      console.log(`  [${i + 1}] ${h.text.slice(0, 70).replace(/\n/g, ' ')}`);
    });
  }
  console.log('============================================');
  console.log(`命中率：${hitCount}/${QUESTIONS.length} · 正确段落出现：${rightCount}/${QUESTIONS.length}`);
}

void main();
