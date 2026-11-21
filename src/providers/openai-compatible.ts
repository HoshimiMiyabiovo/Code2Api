import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalToolCall,
  ContentPart,
  StopReason,
  StreamEvent,
  Usage,
} from '../canonical.js';
import { estimateRequestTokens, roughTokenEstimate } from '../canonical.js';
import type { ModelConfig, OpenAIProviderConfig } from '../config.js';
import { UpstreamError } from '../errors.js';
import { APP_VERSION } from '../config.js';
import type {
  ChatContext,
  DetectedCapabilities,
  ProviderAdapter,
  UpstreamModelInfo,
} from './types.js';

interface OpenAIChunkChoice {
  delta?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }> | null;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

interface OpenAIChunk {
  id?: string;
  model?: string;
  choices?: OpenAIChunkChoice[];
  usage?: Record<string, unknown>;
  error?: unknown;
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function imageUrlOf(part: ContentPart & { type: 'image' }): string | null {
  if (part.url) return part.url;
  if (part.data) {
    return `data:${part.mimeType ?? 'image/png'};base64,${part.data}`;
  }
  return null;
}

function partsToContent(parts: ContentPart[]): string | OpenAIContentPart[] {
  const texts: string[] = [];
  const images: OpenAIContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image') {
      const url = imageUrlOf(part);
      if (url) images.push({ type: 'image_url', image_url: { url } });
    }
  }
  const text = texts.join('');
  if (images.length === 0) return text;
  const content: OpenAIContentPart[] = [];
  if (text) content.push({ type: 'text', text });
  content.push(...images);
  return content;
}

function toolCallsOf(parts: ContentPart[]): Array<{ id: string; name: string; argumentsJson: string }> {
  const calls: Array<{ id: string; name: string; argumentsJson: string }> = [];
  for (const part of parts) {
    if (part.type === 'tool_call') {
      calls.push({ id: part.id, name: part.name, argumentsJson: part.argumentsJson });
    }
  }
  return calls;
}

function toOpenAIMessages(messages: CanonicalMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = toolCallsOf(message.parts);
      const content = partsToContent(
        message.parts.filter((p) => p.type !== 'tool_call' && p.type !== 'thinking'),
      );
      out.push({
        role: 'assistant',
        content: content || (calls.length ? null : ''),
        ...(calls.length
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            }
          : {}),
      });
      continue;
    }

    const toolResults = message.parts.filter((p) => p.type === 'tool_result');
    const rest = message.parts.filter((p) => p.type !== 'tool_result');
    for (const result of toolResults) {
      if (result.type !== 'tool_result') continue;
      const text = result.content.map((c) => c.text).join('');
      out.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: text || '(no output)',
      });
    }
    if (rest.length > 0) {
      const content = partsToContent(rest);
      if (content !== '' || message.role !== 'tool') {
        out.push({
          role: message.role === 'tool' ? 'user' : message.role,
          content,
        });
      }
    }
  }
  return out;
}

function mapToolChoice(choice: CanonicalRequest['toolChoice']): unknown {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function mapStop(stop?: string[]): string[] | undefined {
  return stop && stop.length > 0 ? stop : undefined;
}

/**
 * 从上游 /models 条目中探测上下文窗口。
 * 各厂商字段不统一，按常见命名依次取值；不含 max_tokens（它常表示输出上限）。
 */
const CONTEXT_WINDOW_KEYS = [
  'context_length',
  'max_context_window',
  'max_context_length',
  'context_window',
  'context_window_size',
  'max_context',
  'max_model_len',
  'max_input_tokens',
] as const;

function detectContextWindow(item: Record<string, unknown>): number | undefined {
  for (const key of CONTEXT_WINDOW_KEYS) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (parsed > 0) return Math.trunc(parsed);
    }
  }
  return undefined;
}

/**
 * 从上游 /models 条目解析显式能力声明。
 * 主要识别 OpenRouter 风格的 supported_parameters，以及 input_modalities / modality 中的图像。
 */
function detectCapabilities(item: Record<string, unknown>): DetectedCapabilities {
  const result: DetectedCapabilities = {};
  const params = item.supported_parameters;
  if (Array.isArray(params) && params.length > 0) {
    const set = new Set(params.filter((p): p is string => typeof p === 'string'));
    result.tools = set.has('tools');
    result.reasoning = set.has('reasoning');
  }

  const modalities: unknown[] = [];
  for (const key of ['input_modalities', 'output_modalities']) {
    const value = item[key];
    if (Array.isArray(value)) modalities.push(...value);
  }
  const architecture = item.architecture;
  if (architecture && typeof architecture === 'object' && !Array.isArray(architecture)) {
    const value = (architecture as Record<string, unknown>).input_modalities;
    if (Array.isArray(value)) modalities.push(...value);
  }
  const modality = typeof item.modality === 'string' ? item.modality.toLowerCase() : '';
  if (
    modalities.some((m) => m === 'image' || m === 'image_url' || m === 'vision') ||
    modality.includes('image')
  ) {
    result.vision = true;
  }
  return result;
}

/** 按点号路径写字段，例如 "reasoning.max_tokens"。 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.').filter(Boolean);
  if (keys.length === 0) return;
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]!;
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[keys[keys.length - 1]!] = value;
}

function reasoningEffortOf(
  request: CanonicalRequest,
  model: ModelConfig,
  provider: OpenAIProviderConfig,
): string | undefined {
  if (request.reasoningEffort) return request.reasoningEffort;
  if (!model.capabilities.reasoning) return undefined;
  return model.reasoningEffort ?? provider.defaultReasoningEffort;
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

function normalizeUsage(raw: Record<string, unknown> | undefined): Usage {
  if (!raw) {
    return { inputTokens: 0, outputTokens: 0, estimated: true };
  }
  const promptDetails = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (raw.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: Number(raw.prompt_tokens ?? raw.input_tokens ?? 0),
    outputTokens: Number(raw.completion_tokens ?? raw.output_tokens ?? 0),
    reasoningTokens: Number(
      completionDetails.reasoning_tokens ?? raw.reasoning_tokens ?? 0,
    ),
    cacheReadTokens: Number(
      promptDetails.cached_tokens ?? raw.cached_tokens ?? raw.cache_read_tokens ?? 0,
    ),
    cacheWriteTokens: Number(raw.cache_write_tokens ?? 0),
    estimated: false,
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - Date.now());
  return undefined;
}

function messageFromErrorBody(text: string, status: number, statusText: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string };
      message?: string;
    };
    if (typeof parsed.error?.message === 'string') return parsed.error.message;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // fall through
  }
  const trimmed = text.trim();
  if (trimmed) return trimmed.slice(0, 300);
  return `upstream HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
}

function classifyStatus(status: number): UpstreamError['category'] {
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'payment';
  if (status === 404) return 'model_not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  return 'server';
}

function sseLineToChunk(line: string): Record<string, unknown> | 'done' | null {
  if (!line || line.startsWith(':')) return null;
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return 'done';
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type ReadableStreamReadResult<T> = { done: false; value: T } | { done: true; value?: T };

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  controller: AbortController,
  ctx: ChatContext,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(
        new UpstreamError(`upstream stream idle for ${idleMs}ms`, {
          category: 'timeout',
        }),
      );
    }, idleMs);
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ctx.signal.aborted) {
          reject(new UpstreamError('client aborted', { category: 'cancelled', retryable: false }));
        } else {
          reject(
            new UpstreamError(`upstream stream read failed: ${(error as Error).message}`, {
              category: 'network',
            }),
          );
        }
      },
    );
  });
}

interface OpenResult {
  res: Response;
  controller: AbortController;
  dispose: () => void;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(private readonly cfg: OpenAIProviderConfig) {}

  private headers(stream: boolean, key: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      'user-agent': `code2api/${APP_VERSION}`,
      ...this.cfg.extraHeaders,
    };
    if (key) {
      if (this.cfg.authHeader === 'bearer') headers.authorization = `Bearer ${key}`;
      else headers['x-api-key'] = key;
    }
    return headers;
  }

  private buildBody(
    request: CanonicalRequest,
    model: ModelConfig,
    stream: boolean,
    opts: { tokenField: string; streamOptions: boolean; stripReasoning?: boolean },
  ): Record<string, unknown> {
    const maxTokens =
      request.maxTokens !== undefined && model.maxOutputTokens
        ? Math.min(request.maxTokens, model.maxOutputTokens)
        : request.maxTokens;

    const body: Record<string, unknown> = {
      ...request.extraBody,
      model: model.upstream,
      messages: toOpenAIMessages(request.messages),
      stream,
    };
    if (maxTokens !== undefined) body[opts.tokenField] = maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    const stop = mapStop(request.stop);
    if (stop) body.stop = stop;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        },
      }));
      const toolChoice = mapToolChoice(request.toolChoice);
      if (toolChoice !== undefined) body.tool_choice = toolChoice;
    }
    if (request.responseFormat) body.response_format = request.responseFormat;
    if (!opts.stripReasoning) {
      const effort = reasoningEffortOf(request, model, this.cfg);
      if (effort) body.reasoning_effort = effort;
      if (request.reasoningMaxTokens && this.cfg.reasoningBudgetField) {
        setPath(body, this.cfg.reasoningBudgetField, request.reasoningMaxTokens);
      }
    }
    if (stream && opts.streamOptions) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private async open(
    body: Record<string, unknown>,
    stream: boolean,
    ctx: ChatContext,
    headerTimeoutMs: number,
  ): Promise<OpenResult> {
    if (ctx.signal.aborted) {
      throw new UpstreamError('client aborted', { category: 'cancelled', retryable: false });
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, headerTimeoutMs);
    try {
      const res = await fetch(endpoint(this.cfg.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: this.headers(stream, ctx.key),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return {
        res,
        controller,
        dispose: () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
        },
      };
    } catch (error) {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      if (ctx.signal.aborted) {
        throw new UpstreamError('client aborted', { category: 'cancelled', retryable: false });
      }
      if (timedOut) {
        throw new UpstreamError(
          `upstream did not respond within ${headerTimeoutMs}ms`,
          { category: 'timeout' },
        );
      }
      throw new UpstreamError(`network error: ${(error as Error).message}`, {
        category: 'network',
      });
    }
  }

  private async toUpstreamError(
    res: Response,
    controller: AbortController,
  ): Promise<UpstreamError> {
    let text = '';
    let bodyTimedOut = false;
    const timer = setTimeout(() => {
      bodyTimedOut = true;
      controller.abort();
    }, 10000);
    try {
      text = await res.text();
    } catch {
      text = '';
    } finally {
      clearTimeout(timer);
    }
    if (bodyTimedOut) {
      return new UpstreamError(`upstream HTTP ${res.status} error body timed out`, {
        category: 'server',
        status: res.status,
      });
    }
    const message = messageFromErrorBody(text, res.status, res.statusText);
    return new UpstreamError(message, {
      category: classifyStatus(res.status),
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      bodySnippet: text.slice(0, 2000),
    });
  }

  private mapResponse(json: OpenAIChunk, model: ModelConfig): CanonicalResponse {
    if (json.error) {
      const message =
        typeof json.error === 'object' && json.error !== null
          ? messageFromErrorBody(JSON.stringify(json.error), 200, '')
          : 'upstream returned an error object';
      throw new UpstreamError(message, { category: 'server', retryable: true });
    }
    const choice = json.choices?.[0];
    if (!choice?.message) {
      throw new UpstreamError('upstream returned no choices', {
        category: 'server',
        retryable: true,
      });
    }
    const message = choice.message;
    let text = '';
    if (typeof message.content === 'string') text = message.content;
    else if (Array.isArray(message.content)) {
      text = message.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('');
    }
    const thinking = message.reasoning_content ?? message.reasoning;
    const toolCalls: CanonicalToolCall[] = [];
    for (const [index, call] of (message.tool_calls ?? []).entries()) {
      if (!call?.function) continue;
      const args =
        typeof call.function.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function.arguments ?? {});
      toolCalls.push({
        id: call.id ?? `call_${index}`,
        name: call.function.name ?? '',
        argumentsJson: args,
      });
    }
    return {
      id: json.id ?? `chatcmpl-${Date.now().toString(36)}`,
      model: model.id,
      text,
      thinking: typeof thinking === 'string' && thinking ? thinking : undefined,
      toolCalls,
      stopReason: mapFinishReason(choice.finish_reason),
      usage: normalizeUsage(json.usage),
    };
  }

  async chat(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
  ): Promise<CanonicalResponse> {
    let tokenField = this.cfg.tokenLimitField;
    let stripReasoning = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const body = this.buildBody(request, model, false, {
        tokenField,
        streamOptions: false,
        stripReasoning,
      });
      const opened = await this.open(body, false, ctx, this.cfg.timeouts.ttfbMs);
      if (!opened.res.ok) {
        const error = await this.toUpstreamError(opened.res, opened.controller);
        opened.dispose();
        const snippet = error.bodySnippet ?? '';
        if (attempt === 0 && error.status === 400) {
          if (tokenField === 'max_tokens' && /max_completion_tokens/i.test(snippet)) {
            tokenField = 'max_completion_tokens';
            continue;
          }
          if (tokenField === 'max_completion_tokens' && /max_tokens/i.test(snippet)) {
            tokenField = 'max_tokens';
            continue;
          }
        }
        if (!stripReasoning && error.status === 400 && /reasoning|budget/i.test(snippet)) {
          stripReasoning = true;
          continue;
        }
        throw error;
      }
      try {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          opened.controller.abort();
        }, this.cfg.timeouts.totalMs);
        let text: string;
        try {
          text = await opened.res.text();
        } catch (error) {
          if (timedOut) {
            throw new UpstreamError('upstream response timed out', {
              category: 'timeout',
            });
          }
          if (ctx.signal.aborted) {
            throw new UpstreamError('client aborted', {
              category: 'cancelled',
              retryable: false,
            });
          }
          throw new UpstreamError(`upstream read failed: ${(error as Error).message}`, {
            category: 'network',
          });
        } finally {
          clearTimeout(timer);
        }
        let json: OpenAIChunk;
        try {
          json = JSON.parse(text) as OpenAIChunk;
        } catch {
          throw new UpstreamError('upstream returned invalid JSON', {
            category: 'server',
            retryable: true,
            bodySnippet: text.slice(0, 500),
          });
        }
        const response = this.mapResponse(json, model);
        if (
          response.usage.estimated &&
          response.usage.inputTokens === 0 &&
          response.usage.outputTokens === 0
        ) {
          const outputText =
            response.text + response.toolCalls.map((call) => call.argumentsJson).join('');
          response.usage = {
            inputTokens: estimateRequestTokens(request),
            outputTokens: roughTokenEstimate(outputText),
            estimated: true,
          };
        }
        return response;
      } finally {
        opened.dispose();
      }
    }
    throw new UpstreamError('upstream retry loop exhausted', { category: 'server' });
  }

  /** 拉取上游 /models，返回模型 id 与探测到的上下文窗口。 */
  async listModels(key: string | null, timeoutMs: number): Promise<UpstreamModelInfo[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    try {
      const res = await fetch(endpoint(this.cfg.baseUrl, '/models'), {
        method: 'GET',
        headers: this.headers(false, key),
        signal: controller.signal,
      });
      if (!res.ok) {
        let text = '';
        try {
          text = await res.text();
        } catch {
          text = '';
        }
        throw new UpstreamError(messageFromErrorBody(text, res.status, res.statusText), {
          category: classifyStatus(res.status),
          status: res.status,
        });
      }
      const json = (await res.json()) as { data?: unknown };
      const models: UpstreamModelInfo[] = [];
      if (Array.isArray(json.data)) {
        for (const item of json.data) {
          if (typeof item === 'string' && item) {
            models.push({ id: item });
            continue;
          }
          if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>;
            const id = record.id;
            if (typeof id === 'string' && id) {
              models.push({
                id,
                contextWindow: detectContextWindow(record),
                capabilities: detectCapabilities(record),
              });
            }
          }
        }
      }
      return models;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`模型目录拉取失败: ${(error as Error).message}`, {
        category: 'network',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async *readSse(
    res: Response,
    controller: AbortController,
    ctx: ChatContext,
  ): AsyncGenerator<Record<string, unknown>, void, void> {
    if (!res.body) {
      throw new UpstreamError('upstream returned an empty body', {
        category: 'empty_stream',
        retryable: true,
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const result = await readWithIdleTimeout(
          reader,
          this.cfg.timeouts.idleMs,
          controller,
          ctx,
        );
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          const chunk = sseLineToChunk(line);
          if (chunk === 'done') return;
          if (chunk) yield chunk;
          newline = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      const rest = buffer.trim();
      if (rest) {
        const chunk = sseLineToChunk(rest.replace(/\r$/, ''));
        if (chunk === 'done') return;
        if (chunk) yield chunk;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  async *chatStream(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
  ): AsyncGenerator<StreamEvent, void, void> {
    let tokenField = this.cfg.tokenLimitField;
    let streamOptions = this.cfg.sendStreamOptions;
    let stripReasoning = false;
    let opened: OpenResult | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const body = this.buildBody(request, model, true, {
        tokenField,
        streamOptions,
        stripReasoning,
      });
      opened = await this.open(body, true, ctx, this.cfg.timeouts.ttfbMs);
      if (opened.res.ok) break;
      const error = await this.toUpstreamError(opened.res, opened.controller);
      opened.dispose();
      opened = null;
      const snippet = error.bodySnippet ?? '';
      if (attempt === 0 && error.status === 400) {
        if (streamOptions && /stream_options|include_usage/i.test(snippet)) {
          streamOptions = false;
          continue;
        }
        if (tokenField === 'max_tokens' && /max_completion_tokens/i.test(snippet)) {
          tokenField = 'max_completion_tokens';
          continue;
        }
        if (tokenField === 'max_completion_tokens' && /max_tokens/i.test(snippet)) {
          tokenField = 'max_tokens';
          continue;
        }
      }
      if (!stripReasoning && error.status === 400 && /reasoning|budget/i.test(snippet)) {
        stripReasoning = true;
        continue;
      }
      throw error;
    }
    if (!opened) {
      throw new UpstreamError('upstream connection failed', { category: 'server' });
    }

    const { res, controller, dispose } = opened;
    let sawChunk = false;
    let sawContent = false;
    let finishReason: StopReason | null = null;

    try {
      for await (const raw of this.readSse(res, controller, ctx)) {
        sawChunk = true;
        const chunk = raw as OpenAIChunk;
        if (chunk.error) {
          const message =
            typeof chunk.error === 'object' && chunk.error !== null
              ? messageFromErrorBody(JSON.stringify(chunk.error), 200, '')
              : 'upstream stream error';
          throw new UpstreamError(message, { category: 'server', retryable: true });
        }
        if (chunk.usage) {
          yield { type: 'usage', usage: normalizeUsage(chunk.usage) };
        }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta;
          if (delta) {
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (typeof reasoning === 'string' && reasoning) {
              yield { type: 'thinking_delta', text: reasoning };
            }
            if (typeof delta.content === 'string' && delta.content) {
              sawContent = true;
              yield { type: 'text_delta', text: delta.content };
            } else if (Array.isArray(delta.content)) {
              for (const part of delta.content) {
                if (part && typeof part.text === 'string' && part.text) {
                  sawContent = true;
                  yield { type: 'text_delta', text: part.text };
                }
              }
            }
            for (const [fallbackIndex, call] of (delta.tool_calls ?? []).entries()) {
              const index = call.index ?? fallbackIndex;
              const args = call.function?.arguments;
              const argumentsDelta =
                typeof args === 'string'
                  ? args
                  : args !== undefined
                    ? JSON.stringify(args)
                    : undefined;
              if (!call.id && !call.function?.name && !argumentsDelta) continue;
              sawContent = true;
              yield {
                type: 'tool_call_delta',
                index,
                id: call.id,
                name: call.function?.name,
                argumentsDelta,
              };
            }
          }
          if (choice.finish_reason) {
            finishReason = mapFinishReason(choice.finish_reason);
          }
        }
      }
      if (!sawChunk) {
        throw new UpstreamError('upstream ended before first chunk', {
          category: 'empty_stream',
          retryable: true,
        });
      }
      if (finishReason === null) {
        finishReason = sawContent ? 'stop' : 'unknown';
      }
      yield { type: 'finish', reason: finishReason };
    } finally {
      dispose();
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
  }
}
