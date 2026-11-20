import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CapabilityRequirement,
  ContentPart,
  StopReason,
  StreamEvent,
  TextPart,
  ToolChoice,
  ToolDef,
  Usage,
} from '../canonical.js';
import { GatewayError } from '../errors.js';

function badRequest(message: string): never {
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

function parseImageSource(source: unknown): ContentPart | null {
  if (!isRecord(source)) return null;
  if (source.type === 'base64') {
    const data = asString(source.data);
    if (!data) return null;
    return { type: 'image', data, mimeType: asString(source.media_type) };
  }
  if (source.type === 'url') {
    const url = asString(source.url);
    if (!url) return null;
    return { type: 'image', url };
  }
  return null;
}

function parseToolResultContent(content: unknown): TextPart[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: TextPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      const text = asString(block.text);
      if (text) parts.push({ type: 'text', text });
    }
  }
  return parts;
}

function parseContentBlocks(raw: unknown, role: 'user' | 'assistant'): ContentPart[] {
  if (typeof raw === 'string') {
    return raw ? [{ type: 'text', text: raw }] : [];
  }
  if (!Array.isArray(raw)) badRequest('message.content 必须是字符串或内容块数组');
  const parts: ContentPart[] = [];
  for (const block of raw) {
    if (!isRecord(block)) continue;
    switch (block.type) {
      case 'text': {
        const text = asString(block.text);
        if (text) parts.push({ type: 'text', text });
        break;
      }
      case 'image': {
        const part = parseImageSource(block.source);
        if (part) parts.push(part);
        break;
      }
      case 'tool_use': {
        if (role !== 'assistant') break;
        const id = asString(block.id);
        const name = asString(block.name);
        if (!id || !name) badRequest('tool_use 块缺少 id 或 name');
        parts.push({
          type: 'tool_call',
          id,
          name,
          argumentsJson: JSON.stringify(block.input ?? {}),
        });
        break;
      }
      case 'tool_result': {
        const toolUseId = asString(block.tool_use_id);
        if (!toolUseId) badRequest('tool_result 块缺少 tool_use_id');
        parts.push({
          type: 'tool_result',
          toolCallId: toolUseId,
          content: parseToolResultContent(block.content),
          isError: block.is_error === true,
        });
        break;
      }
      case 'thinking': {
        if (role !== 'assistant') break;
        const text = asString(block.thinking);
        if (text) {
          parts.push({
            type: 'thinking',
            text,
            signature: asString(block.signature),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

function parseSystem(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw || undefined;
  if (Array.isArray(raw)) {
    const text = raw
      .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
      .join('');
    return text || undefined;
  }
  return undefined;
}

function parseTools(raw: unknown): ToolDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) badRequest('tools 必须是数组');
  const tools: ToolDef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = asString(item.name);
    if (!name) continue;
    tools.push({
      name,
      description: asString(item.description),
      inputSchema: item.input_schema ?? { type: 'object', properties: {} },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function parseToolChoice(raw: unknown): ToolChoice | undefined {
  if (!isRecord(raw)) return undefined;
  const type = asString(raw.type);
  if (type === 'auto') return 'auto';
  if (type === 'any') return 'required';
  if (type === 'none') return 'none';
  if (type === 'tool') {
    const name = asString(raw.name);
    if (name) return { name };
  }
  return undefined;
}

export function parseAnthropicRequest(body: unknown): CanonicalRequest {
  if (!isRecord(body)) badRequest('请求体必须是 JSON 对象');
  const model = asString(body.model);
  if (!model) badRequest('model 缺失');

  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
  if (maxTokens === undefined || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    badRequest('max_tokens 必须是正数');
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    badRequest('messages 必须是非空数组');
  }

  const messages: CanonicalMessage[] = [];
  const system = parseSystem(body.system);
  if (system) {
    messages.push({ role: 'system', parts: [{ type: 'text', text: system }] });
  }
  for (const item of body.messages) {
    if (!isRecord(item)) badRequest('messages 中存在非法条目');
    const role = asString(item.role);
    if (role !== 'user' && role !== 'assistant') {
      badRequest(`不支持的 message.role: ${role ?? '(missing)'}`);
    }
    messages.push({ role, parts: parseContentBlocks(item.content, role) });
  }

  const stopSequences = Array.isArray(body.stop_sequences)
    ? body.stop_sequences.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
    : undefined;

  const thinking = isRecord(body.thinking) ? body.thinking : null;
  const reasoningMaxTokens =
    thinking?.type === 'enabled' && typeof thinking.budget_tokens === 'number'
      ? thinking.budget_tokens
      : undefined;

  const metadata = isRecord(body.metadata) ? body.metadata : null;
  const sessionId =
    asString(metadata?.session_id) ?? asString(metadata?.sessionId) ?? undefined;

  const tools = parseTools(body.tools);
  const requires: CapabilityRequirement = {};
  if (tools && tools.length > 0) requires.tools = true;
  if (
    messages.some((message) => message.parts.some((part) => part.type === 'image'))
  ) {
    requires.vision = true;
  }
  if (reasoningMaxTokens !== undefined) requires.reasoning = true;

  const request: CanonicalRequest = {
    model,
    messages,
    stream: body.stream === true,
    sessionId,
    maxTokens,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    stop: stopSequences && stopSequences.length > 0 ? stopSequences : undefined,
    tools,
    toolChoice: parseToolChoice(body.tool_choice),
    reasoningMaxTokens,
    requires: Object.keys(requires).length > 0 ? requires : undefined,
  };
  return request;
}

function mapStopReason(reason: StopReason, hasToolUse: boolean): string {
  if (hasToolUse && (reason === 'stop' || reason === 'unknown')) return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function usageJson(usage: Usage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens
      ? { cache_read_input_tokens: usage.cacheReadTokens }
      : {}),
    ...(usage.cacheWriteTokens
      ? { cache_creation_input_tokens: usage.cacheWriteTokens }
      : {}),
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function encodeAnthropicResponse(
  response: CanonicalResponse,
  id: string,
  emitThinking: boolean,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (emitThinking && response.thinking) {
    content.push({
      type: 'thinking',
      thinking: response.thinking,
      signature: '',
    });
  }
  if (response.text || response.toolCalls.length === 0) {
    content.push({ type: 'text', text: response.text });
  }
  for (const call of response.toolCalls) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: safeParseJson(call.argumentsJson),
    });
  }
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: mapStopReason(response.stopReason, response.toolCalls.length > 0),
    stop_sequence: null,
    usage: usageJson(response.usage),
  };
}

function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface ToolBlockState {
  id: string;
  name: string;
  args: string;
}

export class AnthropicStreamEncoder {
  private nextBlockIndex = 0;
  private openKind: 'text' | 'thinking' | 'tool' | null = null;
  private openIndex = -1;
  private startedBlocks = 0;
  private finishReason: StopReason = 'unknown';
  private usage: Usage | null = null;
  private readonly toolStates = new Map<number, ToolBlockState>();
  private toolOrder: number[] = [];
  private sawToolBlock = false;

  constructor(
    private readonly id: string,
    private readonly model: string,
    private readonly estimatedInputTokens: number,
    private readonly emitThinking: boolean,
  ) {}

  start(): string[] {
    return [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: this.id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.estimatedInputTokens,
            output_tokens: 0,
          },
        },
      }),
    ];
  }

  private closeOpen(): string[] {
    if (this.openKind === null) return [];
    const out = [
      sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: this.openIndex,
      }),
    ];
    this.openKind = null;
    this.openIndex = -1;
    return out;
  }

  private openBlock(
    kind: 'text' | 'thinking' | 'tool',
    startData: Record<string, unknown>,
  ): string[] {
    const index = this.nextBlockIndex;
    this.nextBlockIndex += 1;
    this.openKind = kind;
    this.openIndex = index;
    this.startedBlocks += 1;
    return [
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: startData,
      }),
    ];
  }

  private flushTools(): string[] {
    if (this.toolOrder.length === 0) return [];
    const out: string[] = [...this.closeOpen()];
    for (const key of this.toolOrder) {
      const state = this.toolStates.get(key);
      if (!state) continue;
      out.push(
        ...this.openBlock('tool', {
          type: 'tool_use',
          id: state.id,
          name: state.name,
          input: {},
        }),
      );
      if (state.args) {
        out.push(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: this.openIndex,
            delta: { type: 'input_json_delta', partial_json: state.args },
          }),
        );
      }
      out.push(...this.closeOpen());
      this.sawToolBlock = true;
    }
    this.toolOrder = [];
    this.toolStates.clear();
    return out;
  }

  encode(event: StreamEvent): string[] {
    switch (event.type) {
      case 'text_delta': {
        const out: string[] = [...this.flushTools()];
        if (this.openKind !== 'text') {
          out.push(...this.closeOpen());
          out.push(...this.openBlock('text', { type: 'text', text: '' }));
        }
        out.push(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: this.openIndex,
            delta: { type: 'text_delta', text: event.text },
          }),
        );
        return out;
      }
      case 'thinking_delta': {
        if (!this.emitThinking) return [];
        const out: string[] = [...this.flushTools()];
        if (this.openKind !== 'thinking') {
          out.push(...this.closeOpen());
          out.push(...this.openBlock('thinking', { type: 'thinking', thinking: '' }));
        }
        out.push(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: this.openIndex,
            delta: { type: 'thinking_delta', thinking: event.text },
          }),
        );
        return out;
      }
      case 'tool_call_delta': {
        let state = this.toolStates.get(event.index);
        if (!state) {
          state = {
            id: event.id ?? `toolu_${Date.now().toString(36)}${event.index}`,
            name: event.name ?? '',
            args: '',
          };
          this.toolStates.set(event.index, state);
          this.toolOrder.push(event.index);
        } else {
          if (!state.id && event.id) state.id = event.id;
          if (!state.name && event.name) state.name = event.name;
        }
        if (event.argumentsDelta) state.args += event.argumentsDelta;
        return [];
      }
      case 'usage':
        this.usage = event.usage;
        return [];
      case 'finish':
        this.finishReason = event.reason;
        return [];
    }
  }

  finalize(): string[] {
    const out: string[] = [];
    out.push(...this.flushTools());
    out.push(...this.closeOpen());
    if (this.startedBlocks === 0) {
      out.push(...this.openBlock('text', { type: 'text', text: '' }));
      out.push(...this.closeOpen());
    }
    out.push(
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: mapStopReason(this.finishReason, this.sawToolBlock),
          stop_sequence: null,
        },
        usage: { output_tokens: this.usage?.outputTokens ?? 0 },
      }),
    );
    out.push(sseEvent('message_stop', { type: 'message_stop' }));
    return out;
  }

  error(message: string): string {
    return sseEvent('error', {
      type: 'error',
      error: { type: 'api_error', message },
    });
  }
}
