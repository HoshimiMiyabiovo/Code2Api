import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../canonical.js';
import type { ModelConfig } from '../config.js';

export interface ChatContext {
  key: string | null;
  signal: AbortSignal;
}

/** 从上游 /models 条目探测到的能力；undefined 表示上游未声明。 */
export interface DetectedCapabilities {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

/** 上游 /models 探测结果。 */
export interface UpstreamModelInfo {
  id: string;
  /** 上游声明的上下文窗口（如有）。 */
  contextWindow?: number;
  /** 上游声明的最大输出 tokens（如有）。 */
  maxOutputTokens?: number;
  /** 上游声明支持的能力（如 supported_parameters / modalities）。 */
  capabilities?: DetectedCapabilities;
}

export interface ProviderAdapter {
  chat(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
  ): Promise<CanonicalResponse>;

  chatStream(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
  ): AsyncGenerator<StreamEvent, void, void>;

  /** 拉取上游模型目录（可选，供模型目录同步使用）。 */
  listModels?(key: string | null, timeoutMs: number): Promise<UpstreamModelInfo[]>;

  close?(): Promise<void>;
}
