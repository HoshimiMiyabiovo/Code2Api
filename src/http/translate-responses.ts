import { randomUUID } from 'node:crypto';
import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalToolCall,
  ContentPart,
  StopReason,
  StreamEvent,
  ToolChoice,
  ToolDef,
  Usage,
} from '../canonical.js';
import { GatewayError } from '../errors.js';

function bad(message: string): never {
  throw new GatewayError(message, {
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_request',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseContent(raw: unknown): ContentPart[] {
  if (typeof raw === 'string') {
    return raw ? [{ type: 'text', text: raw }] : [];
  }
  if (!Array.isArray(raw)) return [];
  const parts: ContentPart[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const type = asString(item.type);
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const text = asString(item.text);
      if (text) parts.push({ type: 'text', text });
    } else if (type === 'input_image') {
      const image = item.image_url;
      const url = isRecord(image) ? asString(image.url) : asString(image);
      if (url) parts.push({ type: 'image', url });
    }
  }
  return parts;
}

function parseInput(raw: unknown): CanonicalMessage[] {
  if (typeof raw === 'string') {
    return raw ? [{ role: 'user', parts: [{ type: 'text', text: raw }] }] : [];
  }
  if (!Array.isArray(raw)) bad('input 必须是字符串或数组');
  const messages: CanonicalMessage[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item) messages.push({ role: 'user', parts: [{ type: 'text', text: item }] });
      continue;
    }
    if (!isRecord(item)) continue;
    const type = asString(item.type);
    if (type === 'function_call') {
      const callId = asString(item.call_id) ?? asString(item.id);
      const name = asString(item.name);
      if (!callId || !name) continue;
      messages.push({
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: callId,
            name,
            argumentsJson:
              typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments ?? {}),
          },
        ],
      });
      continue;
    }
    if (type === 'function_call_output') {
      const callId = asString(item.call_id);
      if (!callId) continue;
      const output =
        typeof item.output === 'string'
          ? item.output
          : typeof item.output === 'number' || typeof item.output === 'boolean'
            ? String(item.output)
            : JSON.stringify(item.output ?? '');
      messages.push({
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            toolCallId: callId,
            content: output ? [{ type: 'text', text: output }] : [],
          },
        ],
      });
      continue;
    }
    const roleRaw = asString(item.role);
    if (roleRaw) {
      let role: CanonicalMessage['role'];
      if (roleRaw === 'developer') role = 'system';
      else if (
        roleRaw === 'system' ||
        roleRaw === 'user' ||
        roleRaw === 'assistant' ||
        roleRaw === 'tool'
      ) {
        role = roleRaw;
      } else {
        continue;
      }
      const parts = parseContent(item.content);
      if (parts.length > 0) messages.push({ role, parts });
    }
  }
  return messages;
}

function parseInstructions(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw || undefined;
  if (Array.isArray(raw)) {
    const text = raw
      .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
      .join('');
    return text || undefined;
  }
  return undefined;
}

function parseTools(raw: unknown): ToolDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) bad('tools 必须是数组');
  const tools: ToolDef[] = [];
  for (const item of raw) {
    if (!isRecord(item) || item.type !== 'function') continue;
    const name = asString(item.name);
    if (!name) continue;
    tools.push({
      name,
      description: asString(item.description),
      inputSchema: item.parameters ?? { type: 'object', properties: {} },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function parseToolChoice(raw: unknown): ToolChoice | undefined {
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
  if (isRecord(raw) && raw.type === 'function') {
    const name = asString(raw.name);
    if (name) return { name };
  }
  return undefined;
}

function parseReasoningEffort(raw: unknown): CanonicalRequest['reasoningEffort'] {
  if (!isRecord(raw)) return undefined;
  const effort = asString(raw.effort);
  if (effort === 'minimal') return 'low';
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  if (effort === 'xhigh') return 'high';
  return undefined;
}

export interface ParsedResponsesRequest {
  request: CanonicalRequest;
  previousResponseId?: string;
  store: boolean;
}

export function parseResponsesRequest(body: unknown): ParsedResponsesRequest {
  if (!isRecord(body)) bad('请求体必须是 JSON 对象');
  const model = asString(body.model);
  if (!model) bad('model 缺失');
  if (body.input === undefined || body.input === null) bad('input 缺失');

  const messages: CanonicalMessage[] = [];
  const instructions = parseInstructions(body.instructions);
  if (instructions) {
    messages.push({ role: 'system', parts: [{ type: 'text', text: instructions }] });
  }
  messages.push(...parseInput(body.input));

  const maxTokens =
    typeof body.max_output_tokens === 'number' ? body.max_output_tokens : undefined;
  const tools = parseTools(body.tools);
  const toolChoice = parseToolChoice(body.tool_choice);
  const textFormat =
    isRecord(body.text) && isRecord(body.text.format) ? body.text.format : undefined;

  const extraBody: Record<string, unknown> = {};
  if (typeof body.parallel_tool_calls === 'boolean') {
    extraBody.parallel_tool_calls = body.parallel_tool_calls;
  }

  const request: CanonicalRequest = {
    model,
    messages,
    stream: body.stream === true,
    maxTokens,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    tools,
    toolChoice,
    responseFormat: textFormat,
    reasoningEffort: parseReasoningEffort(body.reasoning),
    extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
  };

  return {
    request,
    previousResponseId: asString(body.previous_response_id),
    store: body.store !== false,
  };
}

function mapStopReason(reason: StopReason, hasToolCalls: boolean): string {
  if (hasToolCalls && (reason === 'stop' || reason === 'unknown')) return 'tool_calls';
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'max_output_tokens';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function usageJson(usage: Usage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

export interface ResponsesResult {
  id: string;
  createdAt: number;
  model: string;
  text: string;
  thinking?: string;
  toolCalls: CanonicalToolCall[];
  stopReason: StopReason;
  usage: Usage;
}

export interface ResponsesOutputItem {
  item: Record<string, unknown>;
  outputIndex: number;
}

export function buildResponsesOutput(result: ResponsesResult): {
  output: Array<Record<string, unknown>>;
  outputText: string;
} {
  const output: Array<Record<string, unknown>> = [];
  if (result.thinking) {
    output.push({
      id: `rs_${randomUUID().replace(/-/g, '')}`,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: result.thinking }],
    });
  }
  if (result.text || result.toolCalls.length === 0) {
    output.push({
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: result.text, annotations: [] }],
    });
  }
  for (const call of result.toolCalls) {
    output.push({
      id: `fc_${randomUUID().replace(/-/g, '')}`,
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      name: call.name,
      arguments: call.argumentsJson,
    });
  }
  return { output, outputText: result.text };
}

export function encodeResponsesResponse(
  result: ResponsesResult,
  previousResponseId?: string,
): Record<string, unknown> {
  const { output, outputText } = buildResponsesOutput(result);
  const incomplete = result.stopReason === 'length';
  return {
    id: result.id,
    object: 'response',
    created_at: Math.floor(result.createdAt / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    error: null,
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    model: result.model,
    output,
    output_text: outputText,
    parallel_tool_calls: true,
    previous_response_id: previousResponseId ?? null,
    usage: usageJson(result.usage),
  };
}

function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

export class ResponsesStreamEncoder {
  private sequence = 0;
  private text = '';
  private thinking = '';
  private usage: Usage = { inputTokens: 0, outputTokens: 0, estimated: false };
  private finish: StopReason = 'unknown';
  private readonly toolCalls = new Map<
    number,
    { callId: string; name: string; args: string; itemId?: string }
  >();
  private messageItemId: string | null = null;
  private messageOutputIndex = 0;
  private messageTextOpen = false;
  private completedText = false;
  private nextOutputIndex = 1;

  constructor(
    readonly id: string,
    private readonly model: string,
    private readonly createdAt: number,
    private readonly previousResponseId?: string,
  ) {}

  setUsageFallback(usage: Usage): void {
    if (
      this.usage.inputTokens === 0 &&
      this.usage.outputTokens === 0 &&
      (usage.inputTokens > 0 || usage.outputTokens > 0)
    ) {
      this.usage = usage;
    }
  }

  private baseResponse(status: string): Record<string, unknown> {
    return {
      id: this.id,
      object: 'response',
      created_at: Math.floor(this.createdAt / 1000),
      status,
      error: null,
      incomplete_details: null,
      model: this.model,
      output: [],
      parallel_tool_calls: true,
      previous_response_id: this.previousResponseId ?? null,
      usage: null,
    };
  }

  start(): string[] {
    this.sequence += 1;
    const created = sseEvent('response.created', {
      sequence_number: this.sequence,
      response: this.baseResponse('in_progress'),
    });
    this.sequence += 1;
    const inProgress = sseEvent('response.in_progress', {
      sequence_number: this.sequence,
      response: this.baseResponse('in_progress'),
    });
    return [created, inProgress];
  }

  private ensureMessageItem(): string[] {
    if (this.messageItemId) return [];
    this.messageItemId = `msg_${randomUUID().replace(/-/g, '')}`;
    this.messageOutputIndex = 0;
    const added = sseEvent('response.output_item.added', {
      sequence_number: ++this.sequence,
      output_index: this.messageOutputIndex,
      item: {
        id: this.messageItemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    const part = sseEvent('response.content_part.added', {
      sequence_number: ++this.sequence,
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    this.messageTextOpen = true;
    return [added, part];
  }

  encode(event: StreamEvent): string[] {
    switch (event.type) {
      case 'keepalive':
        // SSE 注释帧：客户端收到字节（连接与空闲计时器不中断）但语义上忽略。
        return [': keepalive\n\n'];
      case 'text_delta': {
        const out = [...this.ensureMessageItem()];
        this.text += event.text;
        out.push(
          sseEvent('response.output_text.delta', {
            sequence_number: ++this.sequence,
            item_id: this.messageItemId,
            output_index: this.messageOutputIndex,
            content_index: 0,
            delta: event.text,
          }),
        );
        return out;
      }
      case 'thinking_delta':
        this.thinking += event.text;
        return [];
      case 'tool_call_delta': {
        let state = this.toolCalls.get(event.index);
        if (!state) {
          state = {
            callId: event.id ?? `call_${randomUUID().replace(/-/g, '')}`,
            name: event.name ?? '',
            args: '',
          };
          this.toolCalls.set(event.index, state);
        } else {
          if (event.id && !state.callId) state.callId = event.id;
          if (event.name && !state.name) state.name = event.name;
        }
        if (event.argumentsDelta) state.args += event.argumentsDelta;
        return [];
      }
      case 'usage':
        this.usage = event.usage;
        return [];
      case 'finish':
        this.finish = event.reason;
        return [];
    }
  }

  private closeMessage(): string[] {
    if (!this.messageTextOpen || !this.messageItemId) return [];
    const out: string[] = [];
    out.push(
      sseEvent('response.output_text.done', {
        sequence_number: ++this.sequence,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        text: this.text,
      }),
    );
    const part = { type: 'output_text', text: this.text, annotations: [] };
    out.push(
      sseEvent('response.content_part.done', {
        sequence_number: ++this.sequence,
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part,
      }),
    );
    out.push(
      sseEvent('response.output_item.done', {
        sequence_number: ++this.sequence,
        output_index: this.messageOutputIndex,
        item: {
          id: this.messageItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [part],
        },
      }),
    );
    this.messageTextOpen = false;
    this.completedText = true;
    return out;
  }

  private finishToolCalls(): string[] {
    const out: string[] = [];
    for (const state of this.toolCalls.values()) {
      const itemId = `fc_${randomUUID().replace(/-/g, '')}`;
      state.itemId = itemId;
      const outputIndex = this.nextOutputIndex++;
      out.push(
        sseEvent('response.output_item.added', {
          sequence_number: ++this.sequence,
          output_index: outputIndex,
          item: {
            id: itemId,
            type: 'function_call',
            status: 'in_progress',
            call_id: state.callId,
            name: state.name,
            arguments: '',
          },
        }),
      );
      out.push(
        sseEvent('response.function_call_arguments.done', {
          sequence_number: ++this.sequence,
          item_id: itemId,
          output_index: outputIndex,
          arguments: state.args,
        }),
      );
      out.push(
        sseEvent('response.output_item.done', {
          sequence_number: ++this.sequence,
          output_index: outputIndex,
          item: {
            id: itemId,
            type: 'function_call',
            status: 'completed',
            call_id: state.callId,
            name: state.name,
            arguments: state.args,
          },
        }),
      );
    }
    return out;
  }

  private result(): ResponsesResult {
    return {
      id: this.id,
      createdAt: this.createdAt,
      model: this.model,
      text: this.text,
      thinking: this.thinking || undefined,
      toolCalls: [...this.toolCalls.values()].map((state) => ({
        id: state.callId,
        name: state.name,
        argumentsJson: state.args,
      })),
      stopReason:
        this.finish === 'unknown' && (this.text || this.toolCalls.size > 0)
          ? this.toolCalls.size > 0
            ? 'tool_calls'
            : 'stop'
          : this.finish,
      usage: this.usage,
    };
  }

  finalize(): { chunks: string[]; result: ResponsesResult } {
    const out: string[] = [];
    if (!this.completedText) out.push(...this.closeMessage());
    if (!this.messageItemId && this.toolCalls.size === 0) {
      const empty = this.ensureMessageItem();
      out.push(...empty);
      out.push(...this.closeMessage());
    }
    this.nextOutputIndex = this.messageItemId ? 1 : 0;
    out.push(...this.finishToolCalls());
    const result = this.result();
    const response = this.buildFinalResponse(result);
    out.push(
      sseEvent('response.completed', {
        sequence_number: ++this.sequence,
        response,
      }),
    );
    return { chunks: out, result };
  }

  private buildFinalResponse(result: ResponsesResult): Record<string, unknown> {
    const output: Array<Record<string, unknown>> = [];
    if (this.messageItemId) {
      output.push({
        id: this.messageItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.text, annotations: [] }],
      });
    }
    for (const state of this.toolCalls.values()) {
      if (!state.itemId) continue;
      output.push({
        id: state.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: state.callId,
        name: state.name,
        arguments: state.args,
      });
    }
    const incomplete = result.stopReason === 'length';
    return {
      id: this.id,
      object: 'response',
      created_at: Math.floor(this.createdAt / 1000),
      status: incomplete ? 'incomplete' : 'completed',
      error: null,
      incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
      model: this.model,
      output,
      output_text: this.text,
      parallel_tool_calls: true,
      previous_response_id: this.previousResponseId ?? null,
      usage: usageJson(result.usage),
    };
  }

  error(message: string): string {
    const response = {
      ...this.baseResponse('failed'),
      error: { code: 'upstream_error', message },
    };
    return sseEvent('response.failed', {
      sequence_number: ++this.sequence,
      response,
    });
  }
}

export function assistantMessageFromResponse(
  text: string,
  thinking: string | undefined,
  toolCalls: CanonicalToolCall[],
): CanonicalMessage {
  const parts: ContentPart[] = [];
  if (thinking) parts.push({ type: 'thinking', text: thinking });
  if (text) parts.push({ type: 'text', text });
  for (const call of toolCalls) {
    parts.push({
      type: 'tool_call',
      id: call.id,
      name: call.name,
      argumentsJson: call.argumentsJson,
    });
  }
  return { role: 'assistant', parts };
}

export function responsesResultFromCanonical(
  response: CanonicalResponse,
  id: string,
  createdAt: number,
  model: string,
): ResponsesResult {
  return {
    id,
    createdAt,
    model,
    text: response.text,
    thinking: response.thinking,
    toolCalls: response.toolCalls,
    stopReason: response.stopReason,
    usage: response.usage,
  };
}
