/**
 * OpenAI 兼容的视觉识别引擎（智谱 / DeepSeek 共用）。
 * 差异通过构造参数处理：DeepSeek 需 data URI 图片格式且建议关闭思考；
 * 智谱用裸 base64、识别默认开启思考。
 */
import { LLMService } from '../llm/LLMService';
import { VISION_MODEL } from '../llm/LLMService';
import type { RecognitionEngine, RecognitionInput, RecognitionOutput } from './RecognitionEngine';

export interface VisionEngineOptions {
  endpoint?: { url: string; apiKey: string };
  /** 图片传入格式：智谱用裸 base64（raw，默认），DeepSeek 需 data URI */
  imageFormat?: 'raw' | 'dataUri';
  thinking?: 'enabled' | 'disabled';
}

export class ZhipuVisionEngine implements RecognitionEngine {
  readonly engineId = 'zhipu' as const;

  constructor(
    private readonly llm: LLMService,
    private readonly model: string = VISION_MODEL,
    private readonly opts: VisionEngineOptions = {},
  ) {}

  async recognize(input: RecognitionInput): Promise<RecognitionOutput> {
    const r = await this.llm.recognizeImage(input.imageBase64, input.prompt, {
      model: this.model,
      endpoint: this.opts.endpoint,
      imageFormat: this.opts.imageFormat,
      thinking: this.opts.thinking,
      timeoutMs: input.timeoutMs ?? 120000,
    });
    return {
      ok: r.ok,
      raw: r.content,
      latencyMs: r.latencyMs,
      attempts: r.attempts,
      error: r.error,
    };
  }
}
