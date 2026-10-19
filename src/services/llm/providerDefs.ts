/**
 * 讲解提供商定义与解析（纯逻辑，无原生依赖，可离线测试）。
 */

export type ExplainProviderId = 'zhipu_free' | 'zhipu_pro' | 'deepseek' | 'custom' | 'external';

export interface ExplainProviderInfo {
  id: ExplainProviderId;
  label: string;
  tagline: string;
  detail: string;
  supportsRag: boolean;
}

export const EXPLAIN_PROVIDERS: Record<ExplainProviderId, ExplainProviderInfo> = {
  zhipu_free: {
    id: 'zhipu_free',
    label: 'GLM-4.5-Flash',
    tagline: '智谱 · 免费（默认）',
    detail: '应用内生成讲解，支持教材引用（自动标注依据编号）。',
    supportsRag: true,
  },
  zhipu_pro: {
    id: 'zhipu_pro',
    label: 'GLM-5.3',
    tagline: '智谱 · 按量计费',
    detail: '更强的讲解质量，支持教材引用；费用从智谱账户扣除。',
    supportsRag: true,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek-V4.1-Flash',
    tagline: 'DeepSeek · 按量计费',
    detail: '使用 DeepSeek 官方接口（需在下方配置 DeepSeek Key），支持教材引用。',
    supportsRag: true,
  },
  custom: {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    tagline: '自填接口地址与模型名',
    detail: '支持任意 OpenAI 兼容接口（Kimi、通义、本地模型等），支持教材引用。',
    supportsRag: true,
  },
  external: {
    id: 'external',
    label: '分享到豆包等应用',
    tagline: '系统分享 · 不调用模型',
    detail: '把题目文本分享到其他 AI 应用讲解；不支持教材引用。',
    supportsRag: false,
  },
};

export const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
// 免费档用 glm-4.5-flash：同为免费模型，但 glm-4.7-flash 免费档实测排队严重
// （首字 62~92 秒），glm-4.5-flash 首字 ~0.3 秒、整体 ~1.3 秒（2026-10-16 实测）
export const ZHIPU_FREE_MODEL = 'glm-4.5-flash';
export const ZHIPU_PRO_MODEL = 'glm-5.3';
// 2026-10 起 DeepSeek 现役模型为 deepseek-flash（V4.1-Flash）；旧名会自动路由到它
export const DEEPSEEK_MODEL = 'deepseek-flash';

/** 只有官方智谱/DeepSeek 端点保证 function calling；自定义端点走单轮降级。 */
export function supportsAgentTools(url: string): boolean {
  return url === ZHIPU_URL || url === DEEPSEEK_URL;
}

export interface CustomConfig {
  url: string;
  model: string;
  apiKey: string;
}

export type ExplainTarget =
  | { kind: 'api'; url: string; model: string; apiKey: string; providerLabel: string }
  | { kind: 'share' }
  | { kind: 'missing_config'; message: string };

export interface ExplainSecrets {
  zhipuApiKey: string | null;
  deepseekApiKey: string | null;
  custom: CustomConfig;
}

/** 纯函数：按提供商选择解析出实际调用目标（或缺失配置的提示） */
export function resolveExplainTarget(id: ExplainProviderId, secrets: ExplainSecrets): ExplainTarget {
  switch (id) {
    case 'zhipu_free':
      if (!secrets.zhipuApiKey) return { kind: 'missing_config', message: '请先在设置里填写智谱 API Key。' };
      return { kind: 'api', url: ZHIPU_URL, model: ZHIPU_FREE_MODEL, apiKey: secrets.zhipuApiKey, providerLabel: '智谱免费' };
    case 'zhipu_pro':
      if (!secrets.zhipuApiKey) return { kind: 'missing_config', message: '请先在设置里填写智谱 API Key。' };
      return { kind: 'api', url: ZHIPU_URL, model: ZHIPU_PRO_MODEL, apiKey: secrets.zhipuApiKey, providerLabel: '智谱高级' };
    case 'deepseek':
      if (!secrets.deepseekApiKey) return { kind: 'missing_config', message: '请先在设置里填写 DeepSeek API Key。' };
      return { kind: 'api', url: DEEPSEEK_URL, model: DEEPSEEK_MODEL, apiKey: secrets.deepseekApiKey, providerLabel: 'DeepSeek' };
    case 'custom': {
      const { url, model, apiKey } = secrets.custom;
      if (!url.startsWith('http')) return { kind: 'missing_config', message: '请先在设置里填写自定义接口地址（http/https 开头）。' };
      if (!model) return { kind: 'missing_config', message: '请先在设置里填写自定义模型名。' };
      if (!apiKey) return { kind: 'missing_config', message: '请先在设置里填写自定义接口的 API Key。' };
      return { kind: 'api', url, model, apiKey, providerLabel: '自定义模型' };
    }
    case 'external':
    default:
      return { kind: 'share' };
  }
}
