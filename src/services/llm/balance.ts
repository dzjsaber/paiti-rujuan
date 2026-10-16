/**
 * 提供商余额查询：DeepSeek 有公开的 /user/balance 接口（实测可用）；
 * 智谱开放平台无公开余额接口，设置页改为提供控制台链接。
 */

/** 解析 DeepSeek 余额响应（纯函数，便于单测） */
export function parseDeepseekBalance(json: unknown): string | null {
  const j = json as { balance_infos?: { currency?: string; total_balance?: string }[] } | null;
  const info = j?.balance_infos?.[0];
  if (!info || typeof info.total_balance !== 'string') return null;
  return `${info.currency === 'USD' ? '$' : '¥'}${info.total_balance}`;
}

export async function fetchDeepseekBalance(apiKey: string): Promise<string> {
  const r = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw new Error(`查询失败（HTTP ${r.status}）`);
  const text = parseDeepseekBalance(await r.json());
  if (!text) throw new Error('余额响应格式异常');
  return text;
}
