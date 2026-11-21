import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CapabilityRequirement,
  ContentPart,
  StopReason,
  StreamEvent,
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

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseContent(content: unknown, allowImages: boolean): ContentPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    badRequest('message.content 必须是字符串或内容数组');
  }
  const parts: ContentPart[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const type = asString(raw.type);
    if (type === 'text') {
      const text = asString(raw.text);
      if (text) parts.push({ type: 'text', text });
    } else if (type === 'image_url' && allowImages) {
      const image = raw.image_url;
      const url = isRecord(image) ? asString(image.url) : asString(image);
      if (url) parts.push({ type: 'image', url });
    }
  }
  return parts;
}

function parseToolCalls(raw: unknown): ContentPart[] {
  if (!Array.isArray(raw)) return [];
  const parts: ContentPart[] = [];
  for (const [index, call] of raw.entries()) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    const name = asString(fn.name);
    if (!name) continue;
    const argsRaw = fn.arguments;
    const argumentsJson =
      typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw ?? {});
    parts.push({
      type: 'tool_call',
      id: asString(call.id) ?? `call_${index}`,
      name,
      argumentsJson,
    });
  }
  return parts;
}

const PASSTHROUGH_KEYS = [
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'user',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'parallel_tool_calls',
  'service_tier',
] as const;

function parseMessages(raw: unknown): CanonicalMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    badRequest('messages 必须是非空数组');
  }
  const messages: CanonicalMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) badRequest('messages 中存在非法条目');
    const roleRaw = asString(item.role);
    if (!roleRaw) badRequest('message.role 缺失');
    let role: CanonicalMessage['role'];
    if (roleRaw === 'developer') role = 'system';
    else if (roleRaw === 'system' || roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'tool') {
      role = roleRaw;
    } else {
      badRequest(`不支持的 message.role: ${roleRaw}`);
    }

    const parts: ContentPart[] = [];
    if (role === 'tool') {
      const toolCallId = asString(item.tool_call_id);
      if (!toolCallId) badRequest('role=tool 的消息需要 tool_call_id');
      const text =
        typeof item.content === 'string'
          ? item.content
          : Array.isArray(item.content)
            ? item.content
                .map((part) =>
                  isRecord(part) && typeof part.text === 'string' ? part.text : '',
                )
                .join('')
            : '';
      parts.push({
        type: 'tool_result',
        toolCallId,
        content: text ? [{ type: 'text', text }] : [],
      });
    } else {
      parts.push(...parseContent(item.content, true));
      if (role === 'assistant') {
        parts.push(...parseToolCalls(item.tool_calls));
      }
    }

    const message: CanonicalMessage = { role, parts };
    const name = asString(item.name);
    if (name) message.name = name;
    messages.push(message);
  }
  return messages;
}

function parseTools(raw: unknown): ToolDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) badRequest('tools 必须是数组');
  const tools: ToolDef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : null;
    if (!fn) continue;
    const name = asString(fn.name);
    if (!name) continue;
    tools.push({
      name,
      description: asString(fn.description),
      inputSchema: fn.parameters ?? { type: 'object', properties: {} },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function parseToolChoice(raw: unknown): ToolChoice | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
  if (isRecord(raw) && isRecord(raw.function)) {
    const name = asString(raw.function.name);
    if (name) return { name };
  }
  return undefined;
}

function parseStop(raw: unknown): string[] | undefined {
  if (typeof raw === 'string' && raw) return [raw];
  if (Array.isArray(raw)) {
    const stops = raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
    return stops.length > 0 ? stops : undefined;
  }
  return undefined;
}

export interface ParsedOpenAIRequest {
  request: CanonicalRequest;
  includeUsage: boolean;
}

export function parseOpenAIRequest(body: unknown): ParsedOpenAIRequest {
  if (!isRecord(body)) badRequest('请求体必须是 JSON 对象');
  const model = asString(body.model);
  if (!model) badRequest('model 缺失');

  const n = asNumber(body.n);
  if (n !== undefined && n > 1) {
    badRequest('暂不支持 n > 1');
  }

  const stream = body.stream === true;
  const streamOptions = isRecord(body.stream_options) ? body.stream_options : null;
  const includeUsage = streamOptions?.include_usage === true;

  const messages = parseMessages(body.messages);
  const maxTokens = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens);
  const temperature = asNumber(body.temperature);
  const topP = asNumber(body.top_p);
  const stop = parseStop(body.stop);
  const tools = parseTools(body.tools);
  const toolChoice = parseToolChoice(body.tool_choice);
  const responseFormat = isRecord(body.response_format)
    ? (body.response_format as Record<string, unknown>)
    : undefined;
  const reasoningEffortRaw = asString(body.reasoning_effort);
  const reasoningEffort =
    reasoningEffortRaw && reasoningEffortRaw.length <= 32 ? reasoningEffortRaw : undefined;

  const extraBody: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (body[key] !== undefined) extraBody[key] = body[key];
  }

  const metadata = isRecord(body.metadata) ? body.metadata : null;
  const sessionId =
    asString(metadata?.session_id) ?? asString(metadata?.sessionId) ?? undefined;

  const requires: CapabilityRequirement = {};
  if (tools && tools.length > 0) requires.tools = true;
  if (messages.some((message) => message.parts.some((part) => part.type === 'image'))) {
    requires.vision = true;
  }
  if (reasoningEffort) requires.reasoning = true;

  return {
    request: {
      model,
      messages,
      stream,
      sessionId,
      maxTokens,
      temperature,
      topP,
      stop,
      tools,
      toolChoice,
      responseFormat,
      reasoningEffort,
      requires: Object.keys(requires).length > 0 ? requires : undefined,
      extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
    },
    includeUsage,
  };
}

function mapStopReason(reason: StopReason, hasToolCalls: boolean): string {
  if (hasToolCalls && (reason === 'stop' || reason === 'unknown')) return 'tool_calls';
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
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
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.reasoningTokens
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
    ...(usage.cacheReadTokens
      ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }
      : {}),
  };
}

export function encodeOpenAIResponse(
  response: CanonicalResponse,
  id: string,
  created: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: response.toolCalls.length > 0 ? response.text || null : response.text,
  };
  if (response.thinking) message.reasoning_content = response.thinking;
  if (response.toolCalls.length > 0) {
    message.tool_calls = response.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.argumentsJson },
    }));
  }
  return {
    id,
    object: 'chat.completion',
    created,
    model: response.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(response.stopReason, response.toolCalls.length > 0),
        logprobs: null,
      },
    ],
    usage: usageJson(response.usage),
  };
}

export class OpenAIStreamEncoder {
  private finishReason: StopReason | null = null;
  private usage: Usage | null = null;
  private sawToolCall = false;

  constructor(
    private readonly id: string,
    private readonly model: string,
    private readonly created: number,
    private readonly includeUsage: boolean,
  ) {}

  start(): string[] {
    return [
      this.chunk({ role: 'assistant', content: '' }, null),
    ];
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null): string {
    return `data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  }

  encode(event: StreamEvent): string[] {
    switch (event.type) {
      case 'keepalive':
        // SSE 注释帧：客户端收到字节（连接与空闲计时器不中断）但语义上忽略。
        return [': keepalive\n\n'];
      case 'text_delta':
        return [this.chunk({ content: event.text }, null)];
      case 'thinking_delta':
        return [this.chunk({ reasoning_content: event.text }, null)];
      case 'tool_call_delta': {
        this.sawToolCall = true;
        const call: Record<string, unknown> = { index: event.index };
        if (event.id) {
          call.id = event.id;
          call.type = 'function';
        }
        if (event.name !== undefined || event.argumentsDelta !== undefined) {
          const fn: Record<string, unknown> = {};
          if (event.name) fn.name = event.name;
          if (event.argumentsDelta !== undefined) fn.arguments = event.argumentsDelta;
          call.function = fn;
        }
        return [this.chunk({ tool_calls: [call] }, null)];
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
    const reason = mapStopReason(this.finishReason ?? 'unknown', this.sawToolCall);
    const out: string[] = [this.chunk({}, reason)];
    if (this.includeUsage && this.usage) {
      out.push(
        `data: ${JSON.stringify({
          id: this.id,
          object: 'chat.completion.chunk',
          created: this.created,
          model: this.model,
          choices: [],
          usage: usageJson(this.usage),
        })}\n\n`,
      );
    }
    out.push('data: [DONE]\n\n');
    return out;
  }

  error(message: string): string {
    return `data: ${JSON.stringify({
      error: { message, type: 'upstream_error' },
    })}\n\n`;
  }
}
