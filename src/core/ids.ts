/** 本地 ID 生成：时间戳 + 随机后缀，足够本地单机使用（无云同步，无碰撞压力）。 */
export function newId(prefix = ''): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}_${ts}${rand}` : `${ts}${rand}`;
}
