export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  mimeType?: string;
  data?: string;
  url?: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  content: TextPart[];
  isError?: boolean;
}

export interface ThinkingPart {
  type: 'thinking';
  text: string;
  signature?: string;
}

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart | ThinkingPart;

export interface CanonicalMessage {
  role: Role;
  parts: ContentPart[];
  name?: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** 请求对模型能力的要求，用于路由时过滤候选渠道。 */
export interface CapabilityRequirement {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  stream: boolean;
  sessionId?: string;
  workspace?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  responseFormat?: Record<string, unknown>;
  /** 推理强度：OpenAI 标准为 low/medium/high，部分上游支持 xhigh/max/minimal，网关原样透传。 */
  reasoningEffort?: string;
  reasoningMaxTokens?: number;
  requires?: CapabilityRequirement;
  extraBody?: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimated?: boolean;
}

export type StopReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'unknown';

export interface CanonicalToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface CanonicalResponse {
  id: string;
  model: string;
  text: string;
  thinking?: string;
  toolCalls: CanonicalToolCall[];
  stopReason: StopReason;
  usage: Usage;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: StopReason };

export function textOf(parts: ContentPart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export function roughTokenEstimate(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateRequestTokens(request: CanonicalRequest): number {
  let chars = 0;
  for (const message of request.messages) {
    chars += message.role.length + 4;
    for (const part of message.parts) {
      if (part.type === 'text') chars += part.text.length;
      else if (part.type === 'tool_call') chars += part.name.length + part.argumentsJson.length;
      else if (part.type === 'tool_result') chars += textOf(part.content).length;
      else if (part.type === 'thinking') chars += part.text.length;
      else if (part.type === 'image') chars += 1000;
    }
  }
  if (request.tools) {
    for (const tool of request.tools) {
      chars += tool.name.length + JSON.stringify(tool.inputSchema ?? {}).length + (tool.description?.length ?? 0);
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}
