/**
 * 老版 .ppt（Office 97-2003）文本提取（纯函数）：
 * 1) 解析 OLE2 复合文档（CFB），取出 "PowerPoint Document" 流；
 * 2) 按 PowerPoint 二进制记录格式递归遍历，收集 TextCharsAtom(0x0FA0) /
 *    TextBytesAtom(0x0FA8) 的文本，Slide 记录(0x03EE) 作为分页边界；
 * 3) 输出与 pptx 一致的"【第 N 页】"标记格式。
 * shortcut: TextBytesAtom 中的非 ASCII 字节直接丢弃（Hermes 无 GBK 解码器），
 *   中文课件主要使用 UTF-16 的 TextCharsAtom，影响有限；若大量课件丢字再考虑引入 GBK 解码。
 * 限制：仅提取文字；图片、公式、图表不在内。
 */
import { finalizeExtract, type ExtractResult } from './docCommon';

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;

function u16(d: Uint8Array, p: number): number {
  return d[p] | (d[p + 1] << 8);
}
function u32(d: Uint8Array, p: number): number {
  return (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** 解析 CFB 头部/ FAT / 目录，返回指定名称的流数据 */
function readCfbStream(d: Uint8Array, streamName: string): Uint8Array {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  for (let i = 0; i < 8; i++) {
    if (d[i] !== sig[i]) throw new Error('不是有效的 .ppt 文件（OLE 复合文档签名不匹配）');
  }
  const ssz = 1 << u16(d, 30);
  const mssz = 1 << u16(d, 32);
  const firstDirSector = u32(d, 48);
  const miniCutoff = u32(d, 56);
  const firstMiniFatSector = u32(d, 60);
  const firstDifatSector = u32(d, 68);
  if (ssz < 512 || ssz > 65536) throw new Error('.ppt 解析失败：扇区大小异常');

  const sectorOff = (s: number) => 512 + s * ssz;

  // FAT 扇区列表（DIFAT：头部 109 项 + 后续链）
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const v = u32(d, 76 + i * 4);
    if (v !== FREESECT) fatSectors.push(v);
  }
  let difat = firstDifatSector;
  let guard = 0;
  while (difat !== ENDOFCHAIN && difat !== FREESECT && guard++ < 100000) {
    const off = sectorOff(difat);
    if (off + ssz > d.length) break;
    const per = ssz / 4 - 1;
    for (let i = 0; i < per; i++) {
      const v = u32(d, off + i * 4);
      if (v !== FREESECT) fatSectors.push(v);
    }
    difat = u32(d, off + per * 4);
  }

  const fat: number[] = [];
  for (const fs of fatSectors) {
    const off = sectorOff(fs);
    if (off + ssz > d.length) continue;
    for (let i = 0; i < ssz / 4; i++) fat.push(u32(d, off + i * 4));
  }

  const readFatChain = (start: number): Uint8Array => {
    const parts: Uint8Array[] = [];
    let sect = start;
    let g = 0;
    while (sect < 0xfffffffa && g++ < 1_000_000) {
      const off = sectorOff(sect);
      if (off + ssz > d.length) break;
      parts.push(d.subarray(off, off + ssz));
      const next = fat[sect];
      if (next === undefined) break;
      sect = next;
    }
    return concat(parts, parts.length * ssz);
  };

  // 目录项
  const dir = readFatChain(firstDirSector);
  interface Entry {
    name: string;
    type: number;
    start: number;
    size: number;
  }
  const entries: Entry[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = u16(dir, off + 64);
    const type = dir[off + 66];
    if (type === 0 || nameLen < 2) continue;
    let name = '';
    for (let i = 0; i + 1 < nameLen && i < 64; i += 2) name += String.fromCharCode(u16(dir, off + i));
    name = name.replace(/\u0000+$/g, '');
    entries.push({ name, type, start: u32(dir, off + 116), size: u32(dir, off + 120) });
  }

  const target = entries.find((e) => e.type === 2 && e.name === streamName);
  if (!target) {
    const names = entries
      .filter((e) => e.type === 2)
      .map((e) => JSON.stringify(e.name))
      .join(', ');
    throw new Error(`.ppt 解析失败：未找到 ${streamName} 流（实际流：${names || '无'}）`);
  }

  if (target.size >= miniCutoff) {
    return readFatChain(target.start).subarray(0, target.size);
  }
  // 小流（< 4KB）：数据在 root 的 mini stream 内，用 miniFAT 找链
  const miniFatBytes = readFatChain(firstMiniFatSector);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(u32(miniFatBytes, i));
  const root = entries.find((e) => e.type === 5);
  if (!root) throw new Error('.ppt 解析失败：缺少根目录项');
  const miniStream = readFatChain(root.start);
  const parts: Uint8Array[] = [];
  let sect = target.start;
  let g = 0;
  while (sect < 0xfffffffa && g++ < 1_000_000) {
    const off = sect * mssz;
    if (off + mssz > miniStream.length) break;
    parts.push(miniStream.subarray(off, off + mssz));
    const next = miniFat[sect];
    if (next === undefined) break;
    sect = next;
  }
  return concat(parts, parts.length * mssz).subarray(0, target.size);
}

function decodeUtf16(d: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i + 1 < e; i += 2) out += String.fromCharCode(d[i] | (d[i + 1] << 8));
  return out;
}

function decodeBytesAscii(d: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e; i++) {
    const c = d[i];
    if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c);
    else if (c === 0x0d || c === 0x0b) out += '\n';
  }
  return out;
}

function cleanText(t: string): string {
  const s = t.replace(/[\r\u000b\u0000]/g, '\n').replace(/\n{2,}/g, '\n').trim();
  const visible = s.replace(/[\s]/g, '');
  return visible.length >= 2 ? s : '';
}

interface WalkCtx {
  pages: string[];
  current: string[];
}

function flushPage(ctx: WalkCtx): void {
  const text = ctx.current.join('\n').replace(/\n{2,}/g, '\n').trim();
  // 母版/版式页含固定占位符文本，非真实内容，直接丢弃
  if (text && !/单击此处(编辑|添加)/.test(text)) ctx.pages.push(text);
  ctx.current = [];
}

function walkRecords(stream: Uint8Array, start: number, end: number, ctx: WalkCtx, depth: number): void {
  if (depth > 64) return;
  let pos = start;
  let guard = 0;
  while (pos + 8 <= end && guard++ < 1_000_000) {
    const ver = stream[pos] & 0x0f;
    const type = u16(stream, pos + 2);
    const len = u32(stream, pos + 4);
    const bodyStart = pos + 8;
    const bodyEnd = Math.min(bodyStart + len, end);
    if (bodyEnd < bodyStart || bodyEnd <= pos) return; // 长度异常，防死循环
    if (ver === 0x0f) {
      if (type === 0x03ee) flushPage(ctx); // Slide 容器：分页
      walkRecords(stream, bodyStart, bodyEnd, ctx, depth + 1);
    } else if (type === 0x0fa0) {
      const t = cleanText(decodeUtf16(stream, bodyStart, bodyEnd));
      if (t) ctx.current.push(t);
    } else if (type === 0x0fa8) {
      const t = cleanText(decodeBytesAscii(stream, bodyStart, bodyEnd));
      if (t) ctx.current.push(t);
    }
    pos = bodyEnd;
  }
}

export function pptBytesToText(bytes: Uint8Array): ExtractResult {
  const stream = readCfbStream(bytes, 'PowerPoint Document');
  const ctx: WalkCtx = { pages: [], current: [] };
  walkRecords(stream, 0, stream.length, ctx, 0);
  flushPage(ctx);
  const marked = ctx.pages.map((t, i) => `【第 ${i + 1} 页】\n${t}`);
  return finalizeExtract(marked.join('\n\n'), ctx.pages.length);
}
