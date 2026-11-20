import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CanonicalMessage } from '../canonical.js';
import { computeCost, UsageCollector } from '../core/usage.js';
import { ClientAbortError, GatewayError } from '../errors.js';
import { log } from '../logger.js';
import type { GatewayContext } from './context.js';
import {
  assistantMessageFromResponse,
  encodeResponsesResponse,
  parseResponsesRequest,
  ResponsesStreamEncoder,
  responsesResultFromCanonical,
} from './translate-responses.js';
import {
  abortOnDisconnect,
  errorMessage,
  openAIErrorReply,
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

function parseStoredMessages(json: string): CanonicalMessage[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as CanonicalMessage[]) : [];
  } catch {
    return [];
  }
}

export function registerResponsesRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) => {
    const startedAt = performance.now();
    let parsed;
    try {
      parsed = parseResponsesRequest(request.body);
    } catch (error) {
      return openAIErrorReply(reply, internalError(error));
    }
    const canonical = parsed.request;
    const headerSession = sessionIdOf(request);
    if (headerSession) canonical.sessionId = headerSession;
    const headerWorkspace = workspaceOf(request);
    if (headerWorkspace) canonical.workspace = headerWorkspace;
    const responseId = `resp_${randomUUID().replace(/-/g, '')}`;
    const createdAt = Date.now();

    let baseMessages: CanonicalMessage[] = [];
    if (parsed.previousResponseId) {
      const stored = ctx.store.getResponseRecord(parsed.previousResponseId);
      if (!stored) {
        return openAIErrorReply(
          reply,
          new GatewayError(`previous_response_id 不存在: ${parsed.previousResponseId}`, {
            status: 400,
            type: 'invalid_request_error',
            code: 'previous_response_not_found',
          }),
        );
      }
      baseMessages = parseStoredMessages(stored.messagesJson);
      canonical.sessionId = headerSession ?? parsed.previousResponseId;
    } else {
      canonical.sessionId = headerSession ?? responseId;
    }
    canonical.messages = [...baseMessages, ...canonical.messages];

    const meta: RequestMeta = {
      requestId: responseId,
      endpoint: 'openai.responses',
      stream: canonical.stream,
      model: canonical.model,
      sessionId: canonical.sessionId ?? null,
      startedAt,
    };
    const { controller, cleanup } = abortOnDisconnect(request, reply);

    const persist = (
      responseObject: Record<string, unknown>,
      text: string,
      thinking: string | undefined,
      toolCalls: Array<{ id: string; name: string; argumentsJson: string }>,
    ) => {
      if (!parsed.store) return;
      const messages = [
        ...canonical.messages,
        assistantMessageFromResponse(text, thinking, toolCalls),
      ];
      ctx.store.saveResponseRecord({
        id: responseId,
        createdAt,
        model: canonical.model,
        messagesJson: JSON.stringify(messages),
        outputJson: JSON.stringify(responseObject),
      });
    };

    try {
      if (!canonical.stream) {
        const outcome = await ctx.router.complete(canonical, controller.signal);
        const result = responsesResultFromCanonical(
          outcome.response,
          responseId,
          createdAt,
          canonical.model,
        );
        const payload = encodeResponsesResponse(result, parsed.previousResponseId);
        persist(payload, result.text, result.thinking, result.toolCalls);
        const usage = outcome.response.usage;
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
        return reply.header('x-request-id', responseId).send(payload);
      }

      const outcome = await ctx.router.openStream(canonical, controller.signal);
      reply.hijack();
      reply.raw.writeHead(200, { ...SSE_HEADERS, 'x-request-id': responseId });
      const encoder = new ResponsesStreamEncoder(
        responseId,
        canonical.model,
        createdAt,
        parsed.previousResponseId,
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
        if (!clientGone) log.warn(`Responses 流式中断 ${responseId}: ${errorMessage(streamError)}`);
      } else {
        const fallbackUsage = collector.finalize(canonical);
        encoder.setUsageFallback(fallbackUsage);
        const { chunks, result } = encoder.finalize();
        await writeSse(reply.raw, chunks.join(''));
        const payload = encodeResponsesResponse(result, parsed.previousResponseId);
        persist(payload, result.text, result.thinking, result.toolCalls);
        const usage = result.usage;
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
      return openAIErrorReply(reply, gw);
    } finally {
      cleanup();
    }
  });
}
