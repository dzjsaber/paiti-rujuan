/**
 * 去重工具（§3.1 source_hash / V5 题干标准化哈希）。
 * 纯实现，不依赖 Node crypto（React Native 环境通用）。
 * 注意：哈希仅用于本地去重标识，不用于任何安全用途。
 */

const PUNCT = /[\s，。、；：？！""''（）《》【】,.!?;:'"()\[\]<>·…—－-]/g;

/** 标准化题干：去空白、去常见标点、统一小写（用于 V5 疑似重复检测） */
export function normalizeStem(stem: string): string {
  return stem.replace(PUNCT, '').toLowerCase();
}

/** FNV-1a 32 位哈希（十六进制八字串） */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 题干稳定哈希（标准化之后） */
export function stemHash(stem: string): string {
  return hashText(normalizeStem(stem));
}
