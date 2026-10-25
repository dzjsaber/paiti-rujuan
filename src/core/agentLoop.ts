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
  usage?: unknown | null;
  latencyMs?: number;
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
  trace: AgentTrace;
}

export interface AgentTraceTool {
  name: string;
  argumentChars: number;
  latencyMs: number;
  ok: boolean;
  resultChars: number;
  evidenceCount: number;
}

export interface AgentTraceRound {
  index: number;
  mode: 'ask' | 'final';
  latencyMs: number;
  usage: unknown | null;
  outputChars: number;
  tools: AgentTraceTool[];
}

export interface AgentTrace {
  startedAt: string;
  totalMs: number;
  rounds: AgentTraceRound[];
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
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const trace: AgentTrace = { startedAt, totalMs: 0, rounds: [] };
  let toolCount = 0;
  let citationReminderSent = false;

  for (let round = 0; round < maxRounds; round += 1) {
    opts.onStatus?.(round === 0 ? '正在分析题目…' : '正在整理检索结果…');
    const roundStarted = Date.now();
    const result = await opts.model.ask(messages, definitions);
    const traceRound: AgentTraceRound = {
      index: round,
      mode: 'ask',
      latencyMs: result.latencyMs ?? Date.now() - roundStarted,
      usage: result.usage ?? null,
      outputChars: result.content?.length ?? 0,
      tools: [],
    };
    trace.rounds.push(traceRound);
    if (!result.ok) {
      trace.totalMs = Date.now() - startedMs;
      return { ok: false, content: null, error: result.error ?? '生成失败', evidence, toolCount, trace };
    }
    const calls = result.toolCalls ?? [];
    if (calls.length === 0) {
      const content = result.content?.trim() || null;
      if (!content) {
        trace.totalMs = Date.now() - startedMs;
        return { ok: false, content: null, error: '模型没有返回讲解内容', evidence, toolCount, trace };
      }
      opts.onDelta?.(content);
      trace.totalMs = Date.now() - startedMs;
      return { ok: true, content, error: null, evidence, toolCount, trace };
    }

    messages.push(assistantToolMessage(result.content, calls));
    for (const call of calls) {
      const tool = tools.get(call.name);
      const args = parseToolArguments(call.arguments);
      if (!tool) {
        const errorText = `工具不存在：${call.name}`;
        messages.push(toolResultMessage(call, `<tool_result name="${call.name}">\n${errorText}\n</tool_result>`));
        traceRound.tools.push({
          name: call.name,
          argumentChars: call.arguments.length,
          latencyMs: 0,
          ok: false,
          resultChars: errorText.length,
          evidenceCount: 0,
        });
        continue;
      }
      if (!args) {
        const errorText = '工具参数不是合法 JSON，请修正参数后重试。';
        messages.push(toolResultMessage(call, `<tool_result name="${call.name}">\n${errorText}\n</tool_result>`));
        traceRound.tools.push({
          name: call.name,
          argumentChars: call.arguments.length,
          latencyMs: 0,
          ok: false,
          resultChars: errorText.length,
          evidenceCount: 0,
        });
        continue;
      }
      opts.onStatus?.(`正在${tool.label}…`);
      const toolStarted = Date.now();
      try {
        const executed = await tool.execute(args);
        toolCount += 1;
        evidence.push(...(executed.evidence ?? []));
        messages.push(toolResultMessage(call, `<tool_result name="${call.name}">\n${executed.content}\n</tool_result>`));
        traceRound.tools.push({
          name: call.name,
          argumentChars: call.arguments.length,
          latencyMs: Date.now() - toolStarted,
          ok: true,
          resultChars: executed.content.length,
          evidenceCount: executed.evidence?.length ?? 0,
        });
        opts.onStatus?.(`${tool.label}：${executed.summary}`);
      } catch (e) {
        const errorText = `工具执行失败：${String((e as Error)?.message ?? e)}`;
        messages.push(toolResultMessage(call, `<tool_result name="${call.name}">\n${errorText}\n</tool_result>`));
        traceRound.tools.push({
          name: call.name,
          argumentChars: call.arguments.length,
          latencyMs: Date.now() - toolStarted,
          ok: false,
          resultChars: errorText.length,
          evidenceCount: 0,
        });
      }
    }
    if (evidence.length > 0 && !citationReminderSent) {
      messages.push({
        role: 'user',
        content: '当前已有教材依据。最终正文必须至少标注一个实际返回的 [编号]，不得省略引用。',
      });
      citationReminderSent = true;
    }
  }

  opts.onStatus?.('信息已足够，正在生成最终讲解…');
  messages.push({
    role: 'user',
    content: '请根据以上工具结果直接给出最终讲解，不要再调用工具；遵守系统提示的字数和引用要求。',
  });
  const finalStarted = Date.now();
  const final = await opts.model.stream(messages, opts.onDelta ?? (() => undefined));
  trace.rounds.push({
    index: trace.rounds.length,
    mode: 'final',
    latencyMs: final.latencyMs ?? Date.now() - finalStarted,
    usage: final.usage ?? null,
    outputChars: final.content?.length ?? 0,
    tools: [],
  });
  trace.totalMs = Date.now() - startedMs;
  if (!final.ok) {
    return { ok: false, content: null, error: final.error ?? '生成失败', evidence, toolCount, trace };
  }
  const content = final.content?.trim() || null;
  return {
    ok: !!content,
    content,
    error: content ? null : '模型没有返回讲解内容',
    evidence,
    toolCount,
    trace,
  };
}
