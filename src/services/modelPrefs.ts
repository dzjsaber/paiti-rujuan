/**
 * 识别模型档位偏好（以模型 id 为档位键，设置页按模型名分类展示；用户手动切换）。
 *
 * 档位文案基于真机 + 桌面实测：
 * - glm-4.6v-flash（免费）：约 74s/页；实测出现编造题目（幻觉）、选项错位。
 * - glm-4.6v（付费）：约 76s/页；修复幻觉与选项错位；费用约 0.01 元/页。
 * - deepseek-flash（DeepSeek，按量计费）：2026-10-17 实测约 8 秒/页、18 题 JSON 全可解析。
 */
import * as SecureStore from 'expo-secure-store';

export type ModelTier = 'glm-4.6v-flash' | 'glm-4.6v' | 'deepseek-flash';

const STORE_KEY = 'vision_model_tier';

export interface ModelTierInfo {
  id: string;
  label: string;
  tagline: string;
  detail: string;
}

export const MODEL_TIERS: Record<ModelTier, ModelTierInfo> = {
  'glm-4.6v-flash': {
    id: 'glm-4.6v-flash',
    label: 'GLM-4.6V-Flash',
    tagline: '智谱 · 免费（默认）',
    detail: '0 元，但高峰期排队明显（实测 20~90 秒/页，偶发限流）；偶发识别错误（如编造题目、选项错位），请认真复核黄/红标题目。',
  },
  'glm-4.6v': {
    id: 'glm-4.6v',
    label: 'GLM-4.6V',
    tagline: '智谱 · 按量计费（约 0.01 元/页）',
    detail: '实测识别更稳定（修复编造题目、选项错位与符号格式问题），费用从你的智谱账户扣除。',
  },
  'deepseek-flash': {
    id: 'deepseek-flash',
    label: 'DeepSeek-V4.1-Flash',
    tagline: 'DeepSeek · 按量计费（约 1~2 分/页）',
    detail: '实测约 8 秒/页，速度最快（支持图像理解）；需先在"API Key"分组配置 DeepSeek Key。',
  },
};

export async function getModelTier(): Promise<ModelTier> {
  try {
    const v = await SecureStore.getItemAsync(STORE_KEY);
    // 兼容旧值：free → glm-4.6v-flash，pro → glm-4.6v
    if (v === 'free') return 'glm-4.6v-flash';
    if (v === 'pro') return 'glm-4.6v';
    if (v === 'glm-4.6v-flash' || v === 'glm-4.6v' || v === 'deepseek-flash') return v;
    return 'glm-4.6v-flash';
  } catch {
    return 'glm-4.6v-flash';
  }
}

export async function saveModelTier(tier: ModelTier): Promise<void> {
  await SecureStore.setItemAsync(STORE_KEY, tier);
}

export function modelIdForTier(tier: ModelTier): string {
  return MODEL_TIERS[tier].id;
}

// ---------------------------------------------------------------- 讲解方式（F7）

import { EXPLAIN_PROVIDERS, type ExplainProviderId } from './llm/providers';

const EXPLAIN_KEY = 'explain_mode';

/** 读取讲解提供商（兼容旧值：inapp → zhipu_free） */
export async function getExplainProvider(): Promise<ExplainProviderId> {
  try {
    const v = await SecureStore.getItemAsync(EXPLAIN_KEY);
    if (v === 'inapp') return 'zhipu_free';
    if (v && (Object.keys(EXPLAIN_PROVIDERS) as string[]).includes(v)) {
      return v as ExplainProviderId;
    }
    return 'zhipu_free';
  } catch {
    return 'zhipu_free';
  }
}

export async function saveExplainProvider(id: ExplainProviderId): Promise<void> {
  await SecureStore.setItemAsync(EXPLAIN_KEY, id);
}

// ---------------------------------------------------------------- 文档切题接口（F8）

/** 文档切题可换提供商：智谱内容审核较严（政治/历史类可能 1301 被拒），DeepSeek 实测更快更宽松 */
export type CutProviderId = 'zhipu_free' | 'deepseek' | 'custom';

const CUT_KEY = 'doc_cut_provider';

export async function getCutProvider(): Promise<CutProviderId> {
  try {
    const v = await SecureStore.getItemAsync(CUT_KEY);
    if (v === 'deepseek' || v === 'custom') return v;
    return 'zhipu_free';
  } catch {
    return 'zhipu_free';
  }
}

export async function saveCutProvider(id: CutProviderId): Promise<void> {
  await SecureStore.setItemAsync(CUT_KEY, id);
}
