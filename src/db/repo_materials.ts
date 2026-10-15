/**
 * 教材与分块仓库（F9a）：教材原文与 chunk 仅存本地；删除教材时级联清理
 * 分块、FTS 索引与本地原文件。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import { newId } from '../core/ids';

export interface MaterialRow {
  id: string;
  name: string;
  file_path: string | null;
  created_at: string;
}

export interface MaterialSummary extends MaterialRow {
  chunk_count: number;
  image_count: number;
}

export interface MaterialImageRow {
  id: string;
  material_id: string;
  page_no: number | null;
  file_path: string;
  created_at: string;
}

export interface MaterialChunkRow {
  id: string;
  material_id: string;
  content: string;
  source_loc: string | null;
  created_at: string;
}

export async function createMaterial(db: SQLiteDatabase, name: string, filePath: string | null): Promise<string> {
  const id = newId('mat');
  await db.runAsync(
    'INSERT INTO materials(id, name, file_path, created_at) VALUES(?,?,?,?)',
    id,
    name,
    filePath,
    new Date().toISOString(),
  );
  return id;
}

/** 批量写入分块并建立 FTS5 索引（单事务，失败不落半套数据） */
export async function addMaterialChunks(
  db: SQLiteDatabase,
  materialId: string,
  chunks: { content: string; sourceLoc: string }[],
): Promise<number> {
  const now = new Date().toISOString();
  let n = 0;
  await db.withTransactionAsync(async () => {
    for (const c of chunks) {
      const id = newId('mc');
      await db.runAsync(
        'INSERT INTO material_chunks(id, material_id, content, source_loc, created_at) VALUES(?,?,?,?,?)',
        id,
        materialId,
        c.content,
        c.sourceLoc,
        now,
      );
      await db.runAsync('INSERT INTO materials_fts(content, ref_id) VALUES(?,?)', c.content, id);
      n += 1;
    }
  });
  return n;
}

export async function listMaterials(db: SQLiteDatabase): Promise<MaterialSummary[]> {
  return db.getAllAsync<MaterialSummary>(
    `SELECT m.id, m.name, m.file_path, m.created_at,
            (SELECT COUNT(*) FROM material_chunks c WHERE c.material_id = m.id) AS chunk_count,
            (SELECT COUNT(*) FROM material_images i WHERE i.material_id = m.id) AS image_count
       FROM materials m
      ORDER BY m.created_at DESC`,
  );
}

/** 批量登记教材图片（文件由调用方写入私有目录） */
export async function addMaterialImages(
  db: SQLiteDatabase,
  materialId: string,
  images: { pageNo: number | null; filePath: string }[],
): Promise<number> {
  if (images.length === 0) return 0;
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    for (const img of images) {
      await db.runAsync(
        'INSERT INTO material_images(id, material_id, page_no, file_path, created_at) VALUES(?,?,?,?,?)',
        newId('mi'),
        materialId,
        img.pageNo,
        img.filePath,
        now,
      );
    }
  });
  return images.length;
}

export async function listMaterialImages(db: SQLiteDatabase, materialId: string): Promise<MaterialImageRow[]> {
  return db.getAllAsync<MaterialImageRow>(
    'SELECT * FROM material_images WHERE material_id = ? ORDER BY page_no, id',
    materialId,
  );
}

export async function listMaterialChunks(
  db: SQLiteDatabase,
  materialId: string,
  limit = 200,
  offset = 0,
): Promise<MaterialChunkRow[]> {
  return db.getAllAsync<MaterialChunkRow>(
    'SELECT * FROM material_chunks WHERE material_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?',
    materialId,
    limit,
    offset,
  );
}

/** 删除教材：分块（级联）+ FTS 索引 + 本地原文件 */
export async function deleteMaterial(db: SQLiteDatabase, materialId: string, filePath: string | null): Promise<void> {
  const chunks = await db.getAllAsync<{ id: string }>('SELECT id FROM material_chunks WHERE material_id = ?', materialId);
  await db.withTransactionAsync(async () => {
    for (const c of chunks) {
      await db.runAsync('DELETE FROM materials_fts WHERE ref_id = ?', c.id);
    }
    await db.runAsync('DELETE FROM materials WHERE id = ?', materialId);
  });
  if (filePath) {
    try {
      await FileSystemLegacy.deleteAsync(filePath, { idempotent: true });
    } catch {
      /* 文件清理失败不阻塞 */
    }
  }
  // 教材图片目录（按约定：materials/images/<materialId>/）
  try {
    await FileSystemLegacy.deleteAsync(`${FileSystemLegacy.documentDirectory}materials/images/${materialId}/`, {
      idempotent: true,
    });
  } catch {
    /* 目录清理失败不阻塞 */
  }
}
