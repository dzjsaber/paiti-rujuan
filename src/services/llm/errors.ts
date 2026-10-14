/**
 * 智谱开放平台错误语义（核验于 2026-10-15 官方文档"错误码 / 速率限制"）。
 * 用途：把模型/网络错误转成「能否重试 + 用户可读文案」。
 * 禁止依据未经核验的历史资料硬编码错误码含义。
 */

export interface ApiErrorInfo {
  code: string | null;
  http: number | null;
  retryable: boolean;
  userMessage: string;
}

const TABLE: Record<string, { retryable: boolean; userMessage: string }> = {
  '1000': { retryable: false, userMessage: '身份验证失败，请检查 API Key' },
  '1001': { retryable: false, userMessage: '缺少认证信息，请检查 API Key' },
  '1003': { retryable: false, userMessage: '认证已过期，请重新生成 API Key' },
  '1113': { retryable: false, userMessage: '账户已欠费，请充值后重试' },
  '1210': { retryable: false, userMessage: '请求参数有误，请检查设置' },
  '1211': { retryable: false, userMessage: '模型不存在，请检查模型设置' },
  '1212': { retryable: false, userMessage: '当前模型不支持该调用方式' },
  '1213': { retryable: false, userMessage: '请求缺少必要参数' },
  '1214': { retryable: false, userMessage: '请求参数不合法' },
  '1215': { retryable: false, userMessage: '请求参数冲突' },
  '1220': { retryable: false, userMessage: '无权访问该接口' },
  '1261': { retryable: false, userMessage: '内容过长，请缩短后重试' },
  '1301': { retryable: false, userMessage: '内容可能包含敏感信息，已被拒绝' },
  '1302': { retryable: true, userMessage: '请求过于频繁（账户限流），稍后自动重试' },
  '1305': { retryable: true, userMessage: '平台当前繁忙，稍后自动重试' },
  '1308': { retryable: true, userMessage: '已达使用上限，稍后重试' },
  '1310': { retryable: true, userMessage: '已达周期使用上限，稍后重试' },
  '1316': { retryable: true, userMessage: '已达限时使用上限，稍后重试' },
  '1317': { retryable: true, userMessage: '已达周期使用上限，稍后重试' },
};

export function classifyApiError(
  bizCode?: string | number | null,
  httpStatus?: number | null,
  rawMessage?: string | null,
): ApiErrorInfo {
  const code = bizCode === null || bizCode === undefined ? null : String(bizCode);
  const http = httpStatus ?? null;
  if (code && TABLE[code]) {
    return { code, http, retryable: TABLE[code].retryable, userMessage: TABLE[code].userMessage };
  }
  if (http === null) {
    return { code, http, retryable: true, userMessage: '网络异常，请检查连接后重试' };
  }
  if (http >= 500) {
    return { code, http, retryable: true, userMessage: '服务暂时不可用，请稍后重试' };
  }
  if (http === 429) {
    return { code, http, retryable: true, userMessage: '请求受限，请稍后重试' };
  }
  return { code, http, retryable: false, userMessage: rawMessage || '请求失败，请检查后重试' };
}
