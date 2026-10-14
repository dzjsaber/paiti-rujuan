/** 智谱视觉识别引擎（一期唯一实现）。 */
import { LLMService } from '../llm/LLMService';
import { VISION_MODEL } from '../llm/LLMService';
import type { RecognitionEngine, RecognitionInput, RecognitionOutput } from './RecognitionEngine';

export class ZhipuVisionEngine implements RecognitionEngine {
  readonly engineId = 'zhipu' as const;

  constructor(
    private readonly llm: LLMService,
    private readonly model: string = VISION_MODEL,
  ) {}

  async recognize(input: RecognitionInput): Promise<RecognitionOutput> {
    const r = await this.llm.recognizeImage(input.imageBase64, input.prompt, {
      model: this.model,
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
