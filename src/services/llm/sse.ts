/**
 * OpenAI 兼容 SSE 流的增量解析（纯逻辑，可离线测试）。
 * 用法：把网络层收到的文本块依次 push 进来，返回本次新增的正文增量。
 * 只处理 data: 行（OpenAI 流格式：事件按空行分隔，JSON 不跨行）。
 */

export class SseTextStream {
  private buffer = '';
  private done = false;

  /** 喂入一个文本块，返回其中解析出的正文增量（可能为空串） */
  push(chunk: string): string {
    if (this.done) return '';
    this.buffer += chunk;
    let out = '';
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        this.done = true;
        continue;
      }
      try {
        const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const c = j.choices?.[0]?.delta?.content;
        if (typeof c === 'string' && c) out += c;
      } catch {
        /* 非法行（心跳/注释）忽略 */
      }
    }
    return out;
  }
}
