import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { estimateRequestTokens } from '../canonical.js';
import { computeCost, UsageCollector } from '../core/usage.js';
import { ClientAbortError, GatewayError } from '../errors.js';
import { log } from '../logger.js';
import {
  AnthropicStreamEncoder,
  encodeAnthropicResponse,
  parseAnthropicRequest,
} from './translate-anthropic.js';
import type { GatewayContext } from './context.js';
import {
  abortOnDisconnect,
  anthropicErrorReply,
  errorMessage,
  recordRequest,
  sessionIdOf,
  workspaceOf,
  writeSse,
  type RequestMeta,
} from './util.js';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

function internalError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError(errorMessage(error), {
    status: 500,
    type: 'internal_error',
  });
}

export function registerAnthropicRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.post('/v1/messages/count_tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body =
        request.body && typeof request.body === 'object'
          ? { ...(request.body as Record<string, unknown>) }
          : {};
      if (body.max_tokens === undefined) body.max_tokens = 1;
      const canonical = parseAnthropicRequest(body);
      return reply.send({ input_tokens: estimateRequestTokens(canonical) });
    } catch (error) {
      return anthropicErrorReply(reply, internalError(error));
    }
  });

  app.post('/v1/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const startedAt = performance.now();
    let canonical;
    try {
      canonical = parseAnthropicRequest(request.body);
    } catch (error) {
      return anthropicErrorReply(reply, internalError(error));
    }
    const messageId = `msg_${randomUUID().replace(/-/g, '')}`;
    const headerSession = sessionIdOf(request);
    if (headerSession) canonical.sessionId = headerSession;
    const headerWorkspace = workspaceOf(request);
    if (headerWorkspace) canonical.workspace = headerWorkspace;
    const meta: RequestMeta = {
      requestId: messageId,
      endpoint: 'anthropic.messages',
      stream: canonical.stream,
      model: canonical.model,
      sessionId: headerSession,
      startedAt,
    };
    const { controller, cleanup } = abortOnDisconnect(request, reply);

    try {
      if (!canonical.stream) {
        const outcome = await ctx.router.complete(canonical, controller.signal);
        // 记账/计费用上游真实消耗（桥接多 step 累加）；客户端编码仍用 response.usage。
        const usage = outcome.response.upstreamUsage ?? outcome.response.usage;
        recordRequest(ctx, meta, {
          status: 'ok',
          providerId: outcome.providerId,
          keyLabel: outcome.keyLabel,
          upstreamModel: outcome.upstreamModel,
          httpStatus: 200,
          usage,
          costUsd: computeCost(usage, outcome.pricing),
          attempts: outcome.attempts,
        });
        return reply
          .header('x-request-id', messageId)
          .send(encodeAnthropicResponse(outcome.response, messageId, ctx.config.anthropic.emitThinking));
      }

      const outcome = await ctx.router.openStream(canonical, controller.signal);
      reply.hijack();
      reply.raw.writeHead(200, { ...SSE_HEADERS, 'x-request-id': messageId });

      const encoder = new AnthropicStreamEncoder(
        messageId,
        canonical.model,
        estimateRequestTokens(canonical),
        ctx.config.anthropic.emitThinking,
      );
      await writeSse(reply.raw, encoder.start().join(''));

      const collector = new UsageCollector();
      let streamError: unknown = null;
      try {
        for await (const event of outcome.events) {
          collector.observe(event);
          const chunks = encoder.encode(event);
          if (chunks.length > 0) await writeSse(reply.raw, chunks.join(''));
        }
      } catch (error) {
        streamError = error;
      }

      if (streamError) {
        const clientGone =
          streamError instanceof ClientAbortError ||
          controller.signal.aborted ||
          reply.raw.destroyed;
        if (!clientGone) {
          await writeSse(reply.raw, encoder.error(errorMessage(streamError)));
        }
        const usage = collector.finalize(canonical);
        recordRequest(ctx, meta, {
          status: clientGone ? 'cancelled' : 'error',
          providerId: outcome.providerId,
          keyLabel: outcome.keyLabel,
          upstreamModel: outcome.upstreamModel,
          httpStatus: clientGone ? null : 200,
          usage,
          costUsd: computeCost(usage, outcome.pricing),
          ttfbMs: outcome.ttfbMs,
          error: errorMessage(streamError),
          attempts: outcome.attempts,
        });
        if (!clientGone) log.warn(`流式传输中断 ${messageId}: ${errorMessage(streamError)}`);
      } else {
        await writeSse(reply.raw, encoder.finalize().join(''));
        const usage = collector.finalize(canonical);
        recordRequest(ctx, meta, {
          status: 'ok',
          providerId: outcome.providerId,
          keyLabel: outcome.keyLabel,
          upstreamModel: outcome.upstreamModel,
          httpStatus: 200,
          usage,
          costUsd: computeCost(usage, outcome.pricing),
          ttfbMs: outcome.ttfbMs,
          attempts: outcome.attempts,
        });
      }
      reply.raw.end();
      return reply;
    } catch (error) {
      if (error instanceof ClientAbortError || controller.signal.aborted) {
        recordRequest(ctx, meta, {
          status: 'cancelled',
          error: 'client aborted',
          attempts: error instanceof GatewayError ? error.attempts : 0,
        });
        if (!reply.raw.destroyed) reply.raw.destroy();
        return reply;
      }
      const gw = internalError(error);
      recordRequest(ctx, meta, {
        status: 'error',
        providerId: gw.providerId ?? null,
        keyLabel: gw.keyLabel ?? null,
        httpStatus: gw.status,
        error: gw.message,
        attempts: gw.attempts,
      });
      return anthropicErrorReply(reply, gw);
    } finally {
      cleanup();
    }
  });
}
