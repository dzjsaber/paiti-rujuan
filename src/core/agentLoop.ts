/**
 * 轻量 Agent 循环：最多 3 轮工具调用；工具错误回填后继续，最终必须给正文。
 * LLM 通过接口注入，便于离线测试不同提供商返回格式。
 */
import type { RagEvidence } from '../prompts/ragExplain';
import {
  assistantToolMessage,
  parseToolArguments,
  toolResultMessage,
  type AgentToolCall,
  type ChatMessage,
  type ToolDefinition,
} from '../services/llm/toolParsing';

export interface AgentModelResult {
  ok: boolean;
  content: string | null;
  toolCalls: AgentToolCall[];
  error?: string | null;
}

export interface AgentModel {
  ask(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AgentModelResult>;
  stream(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<AgentModelResult>;
}

export interface AgentToolExecution {
  summary: string;
  content: string;
  evidence?: RagEvidence[];
}

export interface AgentTool {
  definition: ToolDefinition;
  label: string;
  execute(args: Record<string, unknown>): Promise<AgentToolExecution>;
}

export interface AgentRunResult {
  ok: boolean;
  content: string | null;
  error: string | null;
  evidence: RagEvidence[];
  toolCount: number;
}

export interface AgentRunOptions {
  model: AgentModel;
  messages: ChatMessage[];
  tools: AgentTool[];
  maxRounds?: number;
  onStatus?: (status: string) => void;
  onDelta?: (delta: string) => void;
}

export async function runAgentLoop(opts: AgentRunOptions): Promise<AgentRunResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const tools = new Map(opts.tools.map((tool) => [tool.definition.function.name, tool]));
  const definitions = opts.tools.map((tool) => tool.definition);
  const messages = [...opts.messages];
  const evidence: RagEvidence[] = [];
  let toolCount = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    opts.onStatus?.(round === 0 ? '正在分析题目…' : '正在整理检索结果…');
    const result = await opts.model.ask(messages, definitions);
    if (!result.ok) {
      return { ok: false, content: null, error: result.error ?? '生成失败', evidence, toolCount };
    }
    const calls = result.toolCalls ?? [];
    if (calls.length === 0) {
      const content = result.content?.trim() || null;
      if (!content) return { ok: false, content: null, error: '模型没有返回讲解内容', evidence, toolCount };
      opts.onDelta?.(content);
      return { ok: true, content, error: null, evidence, toolCount };
    }

    messages.push(assistantToolMessage(result.content, calls));
    for (const call of calls) {
      const tool = tools.get(call.name);
      const args = parseToolArguments(call.arguments);
      if (!tool) {
        messages.push(toolResultMessage(call, `工具不存在：${call.name}`));
        continue;
      }
      if (!args) {
        messages.push(toolResultMessage(call, '工具参数不是合法 JSON，请修正参数后重试。'));
        continue;
      }
      opts.onStatus?.(`正在${tool.label}…`);
      try {
        const executed = await tool.execute(args);
        toolCount += 1;
        evidence.push(...(executed.evidence ?? []));
        messages.push(toolResultMessage(call, executed.content));
        opts.onStatus?.(`${tool.label}：${executed.summary}`);
      } catch (e) {
        messages.push(toolResultMessage(call, `工具执行失败：${String((e as Error)?.message ?? e)}`));
      }
    }
  }

  opts.onStatus?.('信息已足够，正在生成最终讲解…');
  messages.push({
    role: 'user',
    content: '请根据以上工具结果直接给出最终讲解，不要再调用工具；遵守系统提示的字数和引用要求。',
  });
  const final = await opts.model.stream(messages, opts.onDelta ?? (() => undefined));
  if (!final.ok) {
    return { ok: false, content: null, error: final.error ?? '生成失败', evidence, toolCount };
  }
  const content = final.content?.trim() || null;
  return {
    ok: !!content,
    content,
    error: content ? null : '模型没有返回讲解内容',
    evidence,
    toolCount,
  };
}
