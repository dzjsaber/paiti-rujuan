/** OpenAI 兼容 function calling 的纯解析与消息构造。 */

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export function parseToolCalls(message: unknown): AgentToolCall[] {
  const m = message as { tool_calls?: unknown } | null;
  if (!Array.isArray(m?.tool_calls)) return [];
  const out: AgentToolCall[] = [];
  m.tool_calls.forEach((raw, index) => {
    const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
    const name = call?.function?.name;
    if (typeof name !== 'string' || !name) return;
    const args = call?.function?.arguments;
    out.push({
      id: typeof call?.id === 'string' && call.id ? call.id : `call_${index}`,
      name,
      arguments:
        typeof args === 'string'
          ? args
          : args && typeof args === 'object'
            ? JSON.stringify(args)
            : '{}',
    });
  });
  return out;
}

export function parseToolArguments(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function assistantToolMessage(content: string | null, calls: AgentToolCall[]): ChatMessage {
  return {
    role: 'assistant',
    content: content ?? null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

export function toolResultMessage(call: AgentToolCall, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: call.id, content };
}
