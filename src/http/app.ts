import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { ResolvedConfig } from '../config.js';
import { ConcurrencyLimiter } from '../core/limiter.js';
import { ModelCatalog } from '../core/model-catalog.js';
import { PoolSupervisor } from '../core/pool-supervisor.js';
import { Router } from '../core/router.js';
import { GatewayError } from '../errors.js';
import { log } from '../logger.js';
import { Registry } from '../providers/registry.js';
import { Store } from '../store/db.js';
import type { GatewayContext } from './context.js';
import { registerAdminRoutes } from './routes-admin.js';
import { registerAnthropicRoutes } from './routes-anthropic.js';
import { registerOpenAIRoutes } from './routes-openai.js';
import { registerResponsesRoutes } from './routes-responses.js';
import {
  anthropicErrorReply,
  extractClientToken,
  openAIErrorReply,
  tokenMatches,
} from './util.js';

export interface Gateway {
  app: FastifyInstance;
  ctx: GatewayContext;
  shutdown: () => Promise<void>;
}

export interface GatewayOptions {
  configPath?: string;
}

export async function createGateway(
  config: ResolvedConfig,
  options: GatewayOptions = {},
): Promise<Gateway> {
  const adminToken = config.admin.token || randomBytes(18).toString('base64url');
  const store = new Store(config.storage.path);
  store.markStaleOcState();
  store.markStaleZcState();
  store.markStaleQdState();
  const recordAttemptFailure = (info: {
    providerId: string;
    keyLabel: string;
    category: string;
    status?: number;
    message: string;
  }) => {
    try {
      store.recordAttemptFailure({
        ts: Date.now(),
        provider: info.providerId,
        keyLabel: info.keyLabel,
        category: info.category,
        status: info.status,
        message: info.message,
      });
    } catch (error) {
      log.error(`记录上游失败尝试出错: ${(error as Error).message}`);
    }
  };

  const registry = new Registry(config, store);
  const supervisor = new PoolSupervisor();
  const limiter = new ConcurrencyLimiter(
    config.server.maxConcurrency,
    config.server.maxQueueWaitMs,
  );
  const router = new Router(
    registry,
    config.routing.maxAttempts,
    config.routing.cooldowns,
    config.routing.retry,
    recordAttemptFailure,
    config.routing.modelAliases,
    config.routing.modelBlacklist,
    supervisor,
  );
  const catalog = new ModelCatalog();

  const ctx: GatewayContext = {
    config,
    registry,
    router,
    catalog,
    supervisor,
    limiter,
    store,
    startedAt: Date.now(),
    adminToken,
    configPath: options.configPath,
    applyConfig: async (next: ResolvedConfig) => {
      const previous = ctx.registry;
      const nextRegistry = new Registry(next, store);
      const nextRouter = new Router(
        nextRegistry,
        next.routing.maxAttempts,
        next.routing.cooldowns,
        next.routing.retry,
        recordAttemptFailure,
        next.routing.modelAliases,
        next.routing.modelBlacklist,
        supervisor,
      );
      ctx.config = next;
      ctx.registry = nextRegistry;
      ctx.router = nextRouter;
      ctx.catalog.stop();
      ctx.catalog.start(nextRegistry, next.catalog);
      void ctx.catalog.sync(nextRegistry, next.catalog);
      supervisor.start(nextRegistry, next);
      void supervisor.probeHealthAll();
      await previous.close();
      log.info(`配置已热加载，当前渠道: ${nextRegistry.providers.map((p) => p.id).join(', ')}`);
    },
    applyRetryConfig: (next: ResolvedConfig) => {
      ctx.config = next;
      ctx.router = new Router(
        ctx.registry,
        next.routing.maxAttempts,
        next.routing.cooldowns,
        next.routing.retry,
        recordAttemptFailure,
        next.routing.modelAliases,
        next.routing.modelBlacklist,
        supervisor,
      );
      log.info('重试配置已热加载');
    },
  };

  const app = Fastify({
    logger: false,
    bodyLimit: config.server.bodyLimitMb * 1024 * 1024,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-api-key',
      'anthropic-version',
      'anthropic-beta',
      'anthropic-dangerous-direct-browser-access',
      'x-code2api-session',
      'x-code2api-workspace',
    ],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });

  if (config.server.clientKeys.length > 0) {
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      if (!path.startsWith('/v1/')) return;
      if (tokenMatches(extractClientToken(request), config.server.clientKeys)) return;
      const error = new GatewayError('网关客户端密钥无效', {
        status: 401,
        type: 'authentication_error',
        code: 'invalid_api_key',
      });
      if (path.startsWith('/v1/messages')) anthropicErrorReply(reply, error);
      else openAIErrorReply(reply, error);
    });
  }

  if (config.server.maxConcurrency > 0) {
    const generationPaths = new Set([
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/messages',
    ]);
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      if (!generationPaths.has(path)) return;
      let release: (() => void) | null = null;
      try {
        release = await limiter.acquire();
      } catch (error) {
        const gatewayError =
          error instanceof GatewayError
            ? error
            : new GatewayError('网关并发已满', {
                status: 503,
                type: 'overloaded_error',
                code: 'gateway_busy',
              });
        if (path.startsWith('/v1/messages')) anthropicErrorReply(reply, gatewayError);
        else openAIErrorReply(reply, gatewayError);
        return;
      }
      let released = false;
      const finish = () => {
        if (released) return;
        released = true;
        release?.();
      };
      reply.raw.once('close', finish);
      reply.raw.once('finish', finish);
    });
  }

  registerOpenAIRoutes(app, ctx);
  registerAnthropicRoutes(app, ctx);
  registerResponsesRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  if (config.catalog.syncOnStart) {
    const result = await catalog.sync(registry, config.catalog);
    if (result.added > 0) {
      log.info(`模型目录同步完成：新增 ${result.added} 个模型`);
    }
  }
  catalog.start(registry, config.catalog);
  supervisor.start(registry, config);
  const initialHealthTimer = setTimeout(() => {
    void supervisor.probeHealthAll().catch(() => {});
  }, 1500);
  initialHealthTimer.unref?.();

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      log.error(`未处理错误 ${request.method} ${request.url}: ${error.message}`);
    }
    if (!reply.sent) {
      reply.code(status).send({
        error: {
          message: status >= 500 ? '网关内部错误' : error.message,
          type: status >= 500 ? 'internal_error' : 'invalid_request_error',
        },
      });
    }
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({
      error: { message: 'not found', type: 'invalid_request_error' },
    });
  });

  const shutdown = async () => {
    supervisor.stop();
    catalog.stop();
    await app.close();
    await ctx.registry.close();
    store.close();
  };

  return { app, ctx, shutdown };
}
