/**
 * 统一模型调用入口（LLMService）。
 * 职责：读取 API Key（注入）、构造请求、超时、有限重试、错误码映射。
 * 不负责：响应解析（ResponseParser）与业务校验（F2）。
 *
 * 重试策略（§F1）：仅对网络瞬断/超时/5xx/已核实的限流错误（1302/1305 等）重试；
 * 默认重试 1 次、退避 20s（实测 1305 的观察值）；永久性错误不重试。
 */
import { classifyApiError, type ApiErrorInfo } from './errors';

export const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const VISION_MODEL = 'glm-4.6v-flash';
export const TEXT_MODEL = 'glm-4.7-flash';

export interface LLMCallOptions {
  model: string;
  messages: unknown[];
  temperature?: number;
  maxTokens?: number;
  thinking?: 'enabled' | 'disabled';
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  /** 覆盖默认端点与密钥（多提供商支持；缺省用构造器注入的智谱配置） */
  endpoint?: { url: string; apiKey: string };
}

export interface LLMCallResult {
  ok: boolean;
  content: string | null;
  error: ApiErrorInfo | null;
  httpStatus: number | null;
  latencyMs: number;
  attempts: number;
  usage: unknown | null;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type ApiKeyProvider = () => Promise<string | null>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LLMService {
  constructor(
    private readonly getApiKey: ApiKeyProvider,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  /** 识别（视觉模型）：图片以 Base64 直传，不经过任何第三方图床 */
  async recognizeImage(
    imageBase64: string,
    prompt: string,
    opts: Partial<LLMCallOptions> = {},
  ): Promise<LLMCallResult> {
    return this.call({
      model: opts.model ?? VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      temperature: opts.temperature ?? 0.1,
      maxTokens: opts.maxTokens ?? 8192,
      thinking: opts.thinking ?? 'enabled',
      timeoutMs: opts.timeoutMs ?? 120000,
      maxRetries: opts.maxRetries,
      retryDelayMs: opts.retryDelayMs,
    });
  }

  /** 文本调用（F7 讲解 / F9b RAG，后续阶段使用） */
  async complete(prompt: string, opts: Partial<LLMCallOptions> = {}): Promise<LLMCallResult> {
    return this.call({
      model: opts.model ?? TEXT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 1024,
      timeoutMs: opts.timeoutMs ?? 60000,
      maxRetries: opts.maxRetries,
      retryDelayMs: opts.retryDelayMs,
    });
  }

  async call(opts: LLMCallOptions): Promise<LLMCallResult> {
    const key = opts.endpoint?.apiKey ?? (await this.getApiKey());
    if (!key) {
      return {
        ok: false,
        content: null,
        error: { code: null, http: null, retryable: false, userMessage: '未配置 API Key，请在设置页填写' },
        httpStatus: null,
        latencyMs: 0,
        attempts: 0,
        usage: null,
      };
    }

    const maxRetries = opts.maxRetries ?? 1;
    const retryDelay = opts.retryDelayMs ?? 20000;
    const timeoutMs = opts.timeoutMs ?? 60000;
    const payload = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      ...(opts.thinking ? { thinking: { type: opts.thinking } } : {}),
    };

    let attempts = 0;
    let lastError: ApiErrorInfo | null = null;
    let lastStatus: number | null = null;
    let lastLatency = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts = attempt + 1;
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await this.fetchImpl(opts.endpoint?.url ?? ZHIPU_CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        lastLatency = Date.now() - started;
        clearTimeout(timer);

        if (!resp.ok) {
          let bizCode: string | null = null;
          let message: string | null = null;
          try {
            const j = (await resp.json()) as { error?: { code?: string; message?: string } };
            bizCode = j.error?.code ?? null;
            message = j.error?.message ?? null;
          } catch {
            /* 保留原始状态码 */
          }
          lastError = classifyApiError(bizCode, resp.status, message);
          lastStatus = resp.status;
          if (lastError.retryable && attempt < maxRetries) {
            await sleep(retryDelay);
            continue;
          }
          return { ok: false, content: null, error: lastError, httpStatus: lastStatus, latencyMs: lastLatency, attempts, usage: null };
        }

        const j = (await resp.json()) as {
          choices?: { message?: { content?: string }; finish_reason?: string }[];
          usage?: unknown;
        };
        const content = j.choices?.[0]?.message?.content ?? null;
        return { ok: true, content, error: null, httpStatus: resp.status, latencyMs: lastLatency, attempts, usage: j.usage ?? null };
      } catch (e) {
        clearTimeout(timer);
        lastLatency = Date.now() - started;
        const isAbort = (e as Error)?.name === 'AbortError';
        lastError = isAbort
          ? { code: null, http: null, retryable: true, userMessage: '请求超时，请检查网络后重试' }
          : classifyApiError(null, null);
        lastStatus = null;
        if (lastError.retryable && attempt < maxRetries) {
          await sleep(retryDelay);
          continue;
        }
      }
    }
    return { ok: false, content: null, error: lastError, httpStatus: lastStatus, latencyMs: lastLatency, attempts, usage: null };
  }
}
