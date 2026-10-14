/**
 * 图片预处理（F1）：长边压缩到 2000px、JPEG q0.85、复制到应用私有目录、转 Base64。
 * 依据 M0 核验：glm-4.6v-flash 图片限制为每图 ≤5MB、像素 ≤6000×6000、jpg/png/jpeg；
 * 裸 Base64 直传已实测可用（不使用任何第三方图床）。
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import { newId } from '../core/ids';

export const MAX_LONG_EDGE = 2000;
export const JPEG_QUALITY = 0.85;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface PreparedImage {
  /** 应用私有目录中的路径（document/imports/） */
  uri: string;
  width: number;
  height: number;
  bytes: number;
  base64: string;
}

export async function prepareImageForRecognition(
  uri: string,
  width?: number,
  height?: number,
): Promise<PreparedImage> {
  const ctx = ImageManipulator.manipulate(uri);
  const longEdge = Math.max(width ?? 0, height ?? 0);
  if (width && height && longEdge > MAX_LONG_EDGE) {
    const scale = MAX_LONG_EDGE / longEdge;
    ctx.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
  }
  const ref = await ctx.renderAsync();
  const rendered = await ref.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });

  const dir = new Directory(Paths.document, 'imports');
  try {
    dir.create({ idempotent: true });
  } catch {
    /* 目录已存在 */
  }
  const dest = new File(dir, `${newId('img')}.jpg`);
  const src = new File(rendered.uri);
  await src.copy(dest);

  const base64 = await dest.base64();
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`压缩后图片仍超过 5MB（${(bytes / 1024 / 1024).toFixed(1)}MB），请重拍或降低分辨率`);
  }
  return { uri: dest.uri, width: rendered.width, height: rendered.height, bytes, base64 };
}
