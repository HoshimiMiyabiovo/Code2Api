import { timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Usage } from '../canonical.js';
import { ClientAbortError, GatewayError } from '../errors.js';
import type { RequestStatus } from '../store/db.js';
import type { GatewayContext } from './context.js';

export interface RequestMeta {
  requestId: string;
  endpoint: string;
  stream: boolean;
  model: string;
  sessionId: string | null;
  startedAt: number;
}

export interface RecordData {
  status: RequestStatus;
  providerId?: string | null;
  keyLabel?: string | null;
  upstreamModel?: string | null;
  httpStatus?: number | null;
  usage?: Usage;
  costUsd?: number | null;
  ttfbMs?: number | null;
  error?: string | null;
  attempts: number;
}

export function extractClientToken(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1];
  }
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) return apiKey;
  return undefined;
}

export function tokenMatches(token: string | undefined, expected: string[]): boolean {
  if (!token) return false;
  const provided = Buffer.from(token);
  for (const candidate of expected) {
    const wanted = Buffer.from(candidate);
    if (provided.length === wanted.length && timingSafeEqual(provided, wanted)) {
      return true;
    }
  }
  return false;
}

export function sessionIdOf(request: FastifyRequest): string | null {
  // x-code2api-session 是网关自有的会话头；x-opencode-session 允许客户端直接透传
  // （OpenCode Go 的会话标识），网关在配置了 session_header 时会原样带上去。
  for (const name of ['x-code2api-session', 'x-opencode-session'] as const) {
    const raw = request.headers[name];
    if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 200);
  }
  return null;
}

export function workspaceOf(request: FastifyRequest): string | null {
  const raw = request.headers['x-code2api-workspace'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 1024);
  return null;
}

export function parseRange(value: unknown): { key: string; sinceMs: number } {
  const key = typeof value === 'string' ? value : '24h';
  if (key === 'all') return { key: 'all', sinceMs: 0 };
  const ranges: Record<string, number> = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  const span = ranges[key] ?? ranges['24h'];
  return {
    key: ranges[key] ? key : '24h',
    sinceMs: Date.now() - span,
  };
}

export function writeSse(res: ServerResponse, data: string): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) {
      resolve();
      return;
    }
    if (res.write(data)) {
      resolve();
      return;
    }
    const onDrain = () => {
      res.off('close', onClose);
      resolve();
    };
    const onClose = () => {
      res.off('drain', onDrain);
      resolve();
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

export function abortOnDisconnect(
  request: FastifyRequest,
  reply: FastifyReply,
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  reply.raw.once('close', onClose);
  if (request.raw.destroyed) controller.abort();
  return {
    controller,
    cleanup: () => reply.raw.off('close', onClose),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof ClientAbortError) return 'client aborted';
  if (error instanceof Error && error.message) return error.message;
  return 'unknown error';
}

export function openAIErrorReply(reply: FastifyReply, error: GatewayError): FastifyReply {
  if (error.retryAfterSeconds !== undefined) {
    reply.header('retry-after', String(error.retryAfterSeconds));
  }
  return reply.code(error.status).send({
    error: {
      message: error.message,
      type: error.type,
      code: error.code ?? null,
    },
  });
}

function anthropicErrorType(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 413:
      return 'request_too_large';
    case 429:
      return 'rate_limit_error';
    case 529:
      return 'overloaded_error';
    default:
      return 'api_error';
  }
}

export function anthropicErrorReply(reply: FastifyReply, error: GatewayError): FastifyReply {
  if (error.retryAfterSeconds !== undefined) {
    reply.header('retry-after', String(error.retryAfterSeconds));
  }
  return reply.code(error.status).send({
    type: 'error',
    error: {
      type: anthropicErrorType(error.status),
      message: error.message,
    },
  });
}

export function recordRequest(
  ctx: GatewayContext,
  meta: RequestMeta,
  data: RecordData,
): void {
  const usage = data.usage;
  try {
    ctx.store.recordRequest({
      requestId: meta.requestId,
      ts: Date.now(),
      endpoint: meta.endpoint,
      stream: meta.stream,
      requestedModel: meta.model,
      provider: data.providerId ?? null,
      upstreamModel: data.upstreamModel ?? null,
      keyLabel: data.keyLabel ?? null,
      status: data.status,
      httpStatus: data.httpStatus ?? null,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      estimated: usage?.estimated === true,
      costUsd: data.costUsd ?? null,
      latencyMs: Math.round(performance.now() - meta.startedAt),
      ttfbMs: data.ttfbMs ?? null,
      sessionId: meta.sessionId,
      error: data.error ?? null,
      attempts: data.attempts,
    });
  } catch (error) {
    // Never let accounting failures break the request path.
    console.error('记录请求统计失败', error);
  }
}
