/**
 * 识别引擎薄接口（§2.1）。一期只实现一个视觉模型（ZhipuVisionEngine），
 * 不做多引擎自动切换或降级基础设施。
 * 职责边界：引擎只负责"拿到模型原始响应文本 + 时长 + 尝试次数"；
 * 解析与校验由 ResponseParser 与 F2 完成，所有引擎共用。
 */
import type { ApiErrorInfo } from '../llm/errors';

export interface RecognitionInput {
  imageBase64: string;
  prompt: string;
  timeoutMs?: number;
}

export interface RecognitionOutput {
  ok: boolean;
  raw: string | null;
  latencyMs: number;
  attempts: number;
  error: ApiErrorInfo | null;
}

export interface RecognitionEngine {
  readonly engineId: 'zhipu';
  recognize(input: RecognitionInput): Promise<RecognitionOutput>;
}
