/**
 * 云端备份客户端：服务器地址、token 与账号保存在 SecureStore。
 * 上传/下载都走带 30 秒超时的 fetch；错误统一转成可直接展示的中文信息。
 */
import * as SecureStore from 'expo-secure-store';

const SERVER_KEY = 'cloud_server';
const TOKEN_KEY = 'cloud_token';
const EMAIL_KEY = 'cloud_email';
const TIMEOUT_MS = 30_000;

export const DEFAULT_CLOUD_SERVER = 'http://192.168.0.104:8000';

export class CloudError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
  }
}

export function normalizeServer(raw: string): string {
  const server = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/i.test(server)) {
    throw new CloudError('服务器地址需以 http:// 或 https:// 开头');
  }
  return server;
}

export async function getCloudServer(): Promise<string> {
  try {
    const value = await SecureStore.getItemAsync(SERVER_KEY);
    return value?.trim() || DEFAULT_CLOUD_SERVER;
  } catch {
    return DEFAULT_CLOUD_SERVER;
  }
}

export async function saveCloudServer(server: string): Promise<string> {
  const value = normalizeServer(server);
  await SecureStore.setItemAsync(SERVER_KEY, value);
  return value;
}

export async function getCloudSession(): Promise<{ token: string | null; email: string | null }> {
  try {
    const [token, email] = await Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY),
      SecureStore.getItemAsync(EMAIL_KEY),
    ]);
    return { token: token || null, email: email || null };
  } catch {
    return { token: null, email: null };
  }
}

export async function saveCloudSession(token: string, email: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(TOKEN_KEY, token),
    SecureStore.setItemAsync(EMAIL_KEY, email),
  ]);
}

export async function clearCloudSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(EMAIL_KEY),
  ]);
}

function detailFrom(text: string): string | null {
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === 'string') return body.detail;
    if (Array.isArray(body.detail)) {
      const first = body.detail[0] as { msg?: unknown } | undefined;
      if (typeof first?.msg === 'string') return first.msg;
    }
  } catch {
    /* 非 JSON 错误响应 */
  }
  return null;
}

async function request(server: string, path: string, init: RequestInit, token?: string): Promise<string> {
  const base = normalizeServer(server);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      const detail = detailFrom(text);
      if (detail) throw new CloudError(detail, response.status);
      if (response.status === 413) throw new CloudError('备份超过服务器 20MB 限制', 413);
      if (response.status === 401) throw new CloudError('登录已失效，请重新登录', 401);
      throw new CloudError(`服务器返回错误（HTTP ${response.status}）`, response.status);
    }
    return text;
  } catch (e) {
    if (e instanceof CloudError) throw e;
    if ((e as Error)?.name === 'AbortError') {
      throw new CloudError('请求超时（30 秒），请检查服务器地址与网络');
    }
    throw new CloudError('无法连接备份服务器，请检查地址、局域网与后端是否启动');
  } finally {
    clearTimeout(timer);
  }
}

export async function requestLoginCode(server: string, email: string): Promise<number> {
  const text = await request(server, '/api/auth/request-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  try {
    const body = JSON.parse(text) as { expiresIn?: unknown };
    if (typeof body.expiresIn === 'number') return body.expiresIn;
  } catch {
    /* 统一报格式错误 */
  }
  throw new CloudError('服务器返回的验证码信息格式异常');
}

export async function verifyLoginCode(server: string, email: string, code: string): Promise<string> {
  const text = await request(server, '/api/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });
  try {
    const body = JSON.parse(text) as { token?: unknown };
    if (typeof body.token === 'string' && body.token) return body.token;
  } catch {
    /* 统一报格式错误 */
  }
  throw new CloudError('服务器返回的登录信息格式异常');
}

export async function uploadBackup(
  server: string,
  token: string,
  backupText: string,
): Promise<{ version: number; updatedAt: string }> {
  const text = await request(server, '/api/backup', { method: 'PUT', body: backupText }, token);
  const body = JSON.parse(text) as { version?: unknown; updatedAt?: unknown };
  if (typeof body.version !== 'number' || typeof body.updatedAt !== 'string') {
    throw new CloudError('服务器返回的上传结果格式异常');
  }
  return { version: body.version, updatedAt: body.updatedAt };
}

export function downloadBackup(server: string, token: string): Promise<string> {
  return request(server, '/api/backup', { method: 'GET' }, token);
}
