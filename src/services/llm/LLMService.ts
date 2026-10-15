/**
 * 统一模型调用入口（LLMService）。
 * 职责：读取 API Key（注入）、构造请求、超时、有限重试、错误码映射。
 * 不负责：响应解析（ResponseParser）与业务校验（F2）。
 *
 * 重试策略（§F1）：仅对网络瞬断/超时/5xx/已核实的限流错误（1302/1305 等）重试；
 * 默认重试 1 次、退避 20s（实测 1305 的观察值）；永久性错误不重试。
 */
import { classifyApiError, type ApiErrorInfo } from './errors';
import { SseTextStream } from './sse';

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
  /** 智谱联网搜索工具（仅智谱端点支持；其他提供商请勿开启） */
  webSearch?: boolean;
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
      webSearch: opts.webSearch,
      thinking: opts.thinking,
      endpoint: opts.endpoint,
    });
  }

  /**
   * 流式文本调用（F7 讲解）：边生成边回调 onDelta。
   * RN 的 fetch 读不到响应流，这里用 XMLHttpRequest 的增量 responseText 做 SSE 解析；
   * 不做断线重试（失败由用户重新生成）。
   */
  async completeStream(
    prompt: string,
    opts: Partial<LLMCallOptions>,
    onDelta: (delta: string) => void,
  ): Promise<LLMCallResult> {
    const started = Date.now();
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
    const payload = {
      model: opts.model ?? TEXT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1024,
      stream: true,
      ...((opts.endpoint?.url ?? ZHIPU_CHAT_URL) === ZHIPU_CHAT_URL && opts.thinking
        ? { thinking: { type: opts.thinking } }
        : {}),
      ...(opts.webSearch ? { tools: [{ type: 'web_search', web_search: { enable: true } }] } : {}),
    };
    return new Promise<LLMCallResult>((resolve) => {
      const xhr = new XMLHttpRequest();
      const parser = new SseTextStream();
      let content = '';
      let seen = 0;
      const settle = (ok: boolean, error: ApiErrorInfo | null) => {
        resolve({
          ok,
          content: ok ? content : null,
          error,
          httpStatus: xhr.status || null,
          latencyMs: Date.now() - started,
          attempts: 1,
          usage: null,
        });
      };
      const drain = () => {
        const full = xhr.responseText ?? '';
        if (full.length > seen) {
          const delta = parser.push(full.slice(seen));
          seen = full.length;
          if (delta) {
            content += delta;
            onDelta(delta);
          }
        }
      };
      xhr.open('POST', opts.endpoint?.url ?? ZHIPU_CHAT_URL);
      xhr.setRequestHeader('Authorization', `Bearer ${key}`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = opts.timeoutMs ?? 180000;
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 3) {
          drain();
          return;
        }
        if (xhr.readyState !== 4) return;
        drain();
        if (xhr.status >= 200 && xhr.status < 300) {
          if (content) {
            settle(true, null);
            return;
          }
          // 流式没有解析出正文（如思考占满配额、服务端未按 SSE 返回）：降级一次非流式重试
          void this.complete(prompt, opts)
            .then((r) => {
              if (r.ok && r.content) {
                content = r.content;
                onDelta(r.content);
                settle(true, null);
              } else {
                settle(
                  false,
                  r.error ?? { code: null, http: xhr.status, retryable: false, userMessage: '模型返回内容为空' },
                );
              }
            })
            .catch(() =>
              settle(false, { code: null, http: xhr.status, retryable: false, userMessage: '模型返回内容为空' }),
            );
          return;
        }
        let bizCode: string | null = null;
        let message: string | null = null;
        try {
          const j = JSON.parse(xhr.responseText) as { error?: { code?: string; message?: string } };
          bizCode = j.error?.code ?? null;
          message = j.error?.message ?? null;
        } catch {
          /* 保留原始状态码 */
        }
        settle(false, classifyApiError(bizCode, xhr.status, message));
      };
      xhr.ontimeout = () => settle(false, { code: null, http: null, retryable: true, userMessage: '请求超时，请检查网络后重试' });
      xhr.onerror = () => settle(false, classifyApiError(null, null));
      try {
        xhr.send(JSON.stringify(payload));
      } catch (e) {
        settle(false, { code: null, http: null, retryable: false, userMessage: String((e as Error)?.message ?? e) });
      }
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
    // thinking 是智谱专属参数：仅智谱端点附加（DeepSeek/自定义端点收到未知参数可能报错）
    const endpointUrl = opts.endpoint?.url ?? ZHIPU_CHAT_URL;
    const isZhipu = endpointUrl === ZHIPU_CHAT_URL;
    const payload = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      ...(isZhipu && opts.thinking ? { thinking: { type: opts.thinking } } : {}),
      // 智谱联网搜索（服务端执行，模型自动决定是否搜索）
      ...(opts.webSearch ? { tools: [{ type: 'web_search', web_search: { enable: true } }] } : {}),
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
        const resp = await this.fetchImpl(endpointUrl, {
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
