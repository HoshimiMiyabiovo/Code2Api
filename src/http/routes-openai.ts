import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isModelBlacklisted, resolveModelAlias } from '../core/model-rules.js';
import { computeCost, UsageCollector } from '../core/usage.js';
import { ClientAbortError, GatewayError } from '../errors.js';
import { log } from '../logger.js';
import { encodeOpenAIResponse, OpenAIStreamEncoder, parseOpenAIRequest } from './translate-openai.js';
import type { GatewayContext } from './context.js';
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

export function registerOpenAIRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get('/v1/models', async (_request: FastifyRequest, reply: FastifyReply) => {
    const seen = new Set<string>();
    const data: Array<Record<string, unknown>> = [];
    const blacklist = ctx.config.routing.modelBlacklist;
    for (const entry of ctx.registry.modelEntries()) {
      if (!entry.provider.enabled || !entry.provider.keys.hasUsableKey()) continue;
      if (isModelBlacklisted(entry.model.id, blacklist)) continue;
      if (seen.has(entry.model.id)) continue;
      seen.add(entry.model.id);
      data.push({
        id: entry.model.id,
        object: 'model',
        created: 0,
        owned_by: 'code2api',
      });
    }
    for (const alias of Object.keys(ctx.config.routing.modelAliases)) {
      if (alias.includes('*') || alias.includes('?')) continue;
      if (seen.has(alias) || isModelBlacklisted(alias, blacklist)) continue;
      const target = resolveModelAlias(alias, ctx.config.routing.modelAliases);
      if (isModelBlacklisted(target, blacklist)) continue;
      if (ctx.registry.candidates(target).length === 0) continue;
      seen.add(alias);
      data.push({
        id: alias,
        object: 'model',
        created: 0,
        owned_by: 'alias',
      });
    }
    return reply.send({ object: 'list', data });
  });

  app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const startedAt = performance.now();
    let parsed;
    try {
      parsed = parseOpenAIRequest(request.body);
    } catch (error) {
      return openAIErrorReply(reply, internalError(error));
    }
    const canonical = parsed.request;
    const headerSession = sessionIdOf(request);
    if (headerSession) canonical.sessionId = headerSession;
    const headerWorkspace = workspaceOf(request);
    if (headerWorkspace) canonical.workspace = headerWorkspace;
    const requestId = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    const meta: RequestMeta = {
      requestId,
      endpoint: 'openai.chat',
      stream: canonical.stream,
      model: canonical.model,
      sessionId: headerSession,
      startedAt,
    };
    const { controller, cleanup } = abortOnDisconnect(request, reply);

    try {
      if (!canonical.stream) {
        const outcome = await ctx.router.complete(canonical, controller.signal);
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
        return reply
          .header('x-request-id', requestId)
          .send(encodeOpenAIResponse(outcome.response, requestId, created));
      }

      const outcome = await ctx.router.openStream(canonical, controller.signal);
      reply.hijack();
      reply.raw.writeHead(200, { ...SSE_HEADERS, 'x-request-id': requestId });

      const encoder = new OpenAIStreamEncoder(
        requestId,
        canonical.model,
        created,
        parsed.includeUsage,
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
          await writeSse(reply.raw, 'data: [DONE]\n\n');
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
        if (!clientGone) log.warn(`流式传输中断 ${requestId}: ${errorMessage(streamError)}`);
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
      return openAIErrorReply(reply, gw);
    } finally {
      cleanup();
    }
  });
}
