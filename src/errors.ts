export type FailureCategory =
  | 'auth'
  | 'rate_limit'
  | 'payment'
  | 'server'
  | 'network'
  | 'timeout'
  | 'empty_stream'
  | 'stream_cut'
  | 'bad_request'
  | 'model_not_found'
  | 'busy'
  | 'cancelled';

export class UpstreamError extends Error {
  readonly category: FailureCategory;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly bodySnippet?: string;

  constructor(
    message: string,
    opts: {
      category: FailureCategory;
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      bodySnippet?: string;
    },
  ) {
    super(message);
    this.name = 'UpstreamError';
    this.category = opts.category;
    this.status = opts.status;
    this.retryable =
      opts.retryable ??
      (opts.category !== 'bad_request' && opts.category !== 'cancelled');
    this.retryAfterMs = opts.retryAfterMs;
    this.bodySnippet = opts.bodySnippet;
  }
}

export class GatewayError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly retryAfterSeconds?: number;
  readonly providerId?: string;
  readonly keyLabel?: string;
  readonly attempts: number;

  constructor(
    message: string,
    opts: {
      status?: number;
      type?: string;
      code?: string;
      retryAfterMs?: number;
      retryAfterSeconds?: number;
      providerId?: string;
      keyLabel?: string;
      attempts?: number;
    } = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.status = opts.status ?? 502;
    this.type = opts.type ?? 'upstream_error';
    this.code = opts.code;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.providerId = opts.providerId;
    this.keyLabel = opts.keyLabel;
    this.attempts = opts.attempts ?? 0;
  }
}

export class ClientAbortError extends Error {
  constructor() {
    super('client aborted');
    this.name = 'ClientAbortError';
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof ClientAbortError ||
    (error instanceof Error && (error.name === 'AbortError' || error.message === 'client aborted'))
  );
}
