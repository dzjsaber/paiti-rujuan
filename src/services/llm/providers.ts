/**
 * 讲解提供商的密钥存取（SecureStore）；定义与解析见 providerDefs（纯逻辑）。
 */
import * as SecureStore from 'expo-secure-store';
import type { CustomConfig } from './providerDefs';

export * from './providerDefs';

const DEEPSEEK_KEY_STORE = 'deepseek_api_key';
const CUSTOM_KEY_STORE = 'custom_api_key';
const CUSTOM_URL_STORE = 'custom_api_url';
const CUSTOM_MODEL_STORE = 'custom_api_model';

export async function getDeepseekKey(): Promise<string | null> {
  try {
    const v = await SecureStore.getItemAsync(DEEPSEEK_KEY_STORE);
    return v?.trim() || null;
  } catch {
    return null;
  }
}

export async function saveDeepseekKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(DEEPSEEK_KEY_STORE, key.trim());
}

export async function getCustomConfig(): Promise<CustomConfig> {
  try {
    const [url, model, apiKey] = await Promise.all([
      SecureStore.getItemAsync(CUSTOM_URL_STORE),
      SecureStore.getItemAsync(CUSTOM_MODEL_STORE),
      SecureStore.getItemAsync(CUSTOM_KEY_STORE),
    ]);
    return { url: url?.trim() ?? '', model: model?.trim() ?? '', apiKey: apiKey?.trim() ?? '' };
  } catch {
    return { url: '', model: '', apiKey: '' };
  }
}

export async function saveCustomConfig(cfg: CustomConfig): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(CUSTOM_URL_STORE, cfg.url.trim()),
    SecureStore.setItemAsync(CUSTOM_MODEL_STORE, cfg.model.trim()),
    SecureStore.setItemAsync(CUSTOM_KEY_STORE, cfg.apiKey.trim()),
  ]);
}
