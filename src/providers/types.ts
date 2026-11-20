import type { CanonicalRequest, CanonicalResponse, StreamEvent } from '../canonical.js';
import type { ModelConfig } from '../config.js';

export interface ChatContext {
  key: string | null;
  signal: AbortSignal;
}

/** 上游 /models 探测结果。 */
export interface UpstreamModelInfo {
  id: string;
  /** 上游声明的上下文窗口（如有）。 */
  contextWindow?: number;
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
