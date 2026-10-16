/**
 * 识别模型档位偏好（用户可选手动切换；不做运行时自动切换/降级）。
 *
 * 档位文案基于 2026-10-15 真机 + 桌面实测（样本 11_负数分数.jpeg，四模型对照）：
 * - glm-4.6v-flash（免费）：约 74s/页；实测出现编造题目（幻觉）、选项错位。
 * - glm-4.6v（付费）：约 76s/页；修复幻觉与选项错位；费用约 0.01 元/页。
 * - glm-4.6v-flashx：约 36s/页，但题干错乱较多，质量不足，不提供。
 * - glm-5.3-flash：质量最高但约 8 分钟/页（深度思考消耗配额），不适合交互场景，不提供。
 */
import * as SecureStore from 'expo-secure-store';

export type ModelTier = 'free' | 'pro';

const STORE_KEY = 'vision_model_tier';

export interface ModelTierInfo {
  id: string;
  label: string;
  tagline: string;
  detail: string;
}

export const MODEL_TIERS: Record<ModelTier, ModelTierInfo> = {
  free: {
    id: 'glm-4.6v-flash',
    label: '免费（默认）',
    tagline: '0 元 · 约 1 分钟/页',
    detail: '实测偶发识别错误（如编造题目、选项错位），请认真复核黄色/红色标记的题目。',
  },
  pro: {
    id: 'glm-4.6v',
    label: '高级（按量自付）',
    tagline: '约 0.01 元/页 · 速度相近',
    detail: '实测识别更稳定（修复编造题目、选项错位与符号格式问题），费用从你的智谱账户扣除。',
  },
};

export async function getModelTier(): Promise<ModelTier> {
  try {
    const v = await SecureStore.getItemAsync(STORE_KEY);
    return v === 'pro' ? 'pro' : 'free';
  } catch {
    return 'free';
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
