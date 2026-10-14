/**
 * API Key 存储（expo-secure-store）。
 * 安全边界：本机保存用户自带 Key；不在源码/日志/版本控制中出现。
 * 注意：SecureStore 不能防止有设备权限者的取证读取，产品文案不得承诺"绝对安全"。
 */
import * as SecureStore from 'expo-secure-store';

const STORE_KEY = 'zhipu_api_key';

export async function getApiKey(): Promise<string | null> {
  try {
    const v = await SecureStore.getItemAsync(STORE_KEY);
    const t = v?.trim();
    return t ? t : null;
  } catch {
    return null;
  }
}

export async function saveApiKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(STORE_KEY, key.trim());
}

export async function clearApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(STORE_KEY);
}

export function maskKey(key: string | null): string {
  if (!key) return '（未配置）';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}
