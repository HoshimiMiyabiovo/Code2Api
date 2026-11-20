import { readFileSync, createReadStream, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { APP_VERSION } from '../config.js';
import { deleteChannel, parseChannelInput, upsertChannel } from '../core/config-editor.js';
import { maskKey } from '../core/keys.js';
import type { ProviderMonitorSnapshot } from '../core/pool-supervisor.js';
import { GatewayError } from '../errors.js';
import { OpenCodeAdapter, type PendingQuestionView } from '../providers/opencode.js';
import type { ProviderRuntime } from '../providers/registry.js';
import type { ProviderKeyStats } from '../store/db.js';
import type { GatewayContext } from './context.js';
import { extractClientToken, parseRange, tokenMatches } from './util.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

function asset(name: string): string {
  return readFileSync(`${PUBLIC_DIR}${name}`, 'utf8');
}

function statsKey(provider: string, keyLabel: string | null): string {
  return `${provider}\u0000${keyLabel ?? ''}`;
}

function emptyStats(): ProviderKeyStats {
  return {
    provider: '',
    keyLabel: null,
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

function openCodeAdapterOf(provider: ProviderRuntime): OpenCodeAdapter | null {
  return provider.adapter instanceof OpenCodeAdapter ? provider.adapter : null;
}

function channelView(
  provider: ProviderRuntime,
  monitoring: ProviderMonitorSnapshot,
): Record<string, unknown> {
  const keyStates = new Map(
    provider.keys.snapshot().map((key) => [key.label, key] as const),
  );
  const config = provider.config;
  const adapter = openCodeAdapterOf(provider);
  const keys =
    config.type === 'openai-compatible'
      ? config.keys.map((key) => {
          const state = keyStates.get(key.label);
          return {
            label: key.label,
            masked: maskKey(key.key),
            keyEnv: key.keyEnv ?? null,
            hasKey: key.key !== null,
            status: state?.status ?? (key.missingEnv ? 'missing_env' : 'ready'),
            cooldownRemainingMs: state?.cooldownRemainingMs ?? 0,
          };
        })
      : [];
  return {
    id: provider.id,
    type: provider.type,
    priority: provider.priority,
    enabled: provider.enabled,
    disabledReason: provider.disabledReason ?? null,
    baseUrl: config.type === 'openai-compatible' ? config.baseUrl : null,
    authHeader: config.type === 'openai-compatible' ? config.authHeader : null,
    tokenLimitField:
      config.type === 'openai-compatible' ? config.tokenLimitField : null,
    sendStreamOptions:
      config.type === 'openai-compatible' ? config.sendStreamOptions : null,
    opencode:
      config.type === 'opencode'
        ? {
            command: config.command,
            workspace: config.workspace,
            workspaceRoots: config.workspaceRoots,
            agent: config.agent,
            permissionMode: config.permissionMode,
            autoModels: config.autoModels,
            maxWorkers: config.maxWorkers,
            maxConcurrentSessions: config.maxConcurrentSessions,
            idleTtlMs: config.idleTtlMs,
            memoryBudgetMb: config.memoryBudgetMb,
            baseUrl: config.baseUrl ?? null,
            worker: adapter?.workerSnapshot() ?? null,
            pool: adapter?.poolSnapshot() ?? null,
          }
        : null,
    monitoring,
    keys,
    models: provider.models.map((model) => ({
      id: model.id,
      upstream: model.upstream,
      contextWindow: model.contextWindow ?? null,
      maxOutputTokens: model.maxOutputTokens ?? null,
      capabilities: model.capabilities,
      pricing: model.pricing ?? null,
      reasoningEffort: model.reasoningEffort ?? null,
      source: model.source ?? 'config',
    })),
    syncModels: config.type === 'openai-compatible' ? config.syncModels : null,
    defaultReasoningEffort:
      config.type === 'openai-compatible' ? config.defaultReasoningEffort ?? null : null,
    reasoningBudgetField:
      config.type === 'openai-compatible' ? config.reasoningBudgetField ?? null : null,
  };
}

function channelError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof GatewayError) {
    return reply.code(error.status).send({
      error: { message: error.message, type: error.type, code: error.code ?? null },
    });
  }
  throw error;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const adminGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractClientToken(request);
    if (!tokenMatches(token, [ctx.adminToken])) {
      await reply.code(401).send({ error: { message: 'admin token 无效', type: 'authentication_error' } });
    }
  };

  app.get('/', async (_request, reply) => reply.redirect('/admin'));

  app.get('/admin', async (_request, reply) => {
    return reply
      .header('cache-control', 'no-store')
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      )
      .type('text/html; charset=utf-8')
      .send(asset('index.html'));
  });

  app.get('/admin/app.js', async (_request, reply) => {
    return reply
      .header('cache-control', 'no-store')
      .type('text/javascript; charset=utf-8')
      .send(asset('app.js'));
  });

  app.get('/admin/style.css', async (_request, reply) => {
    return reply
      .header('cache-control', 'no-store')
      .type('text/css; charset=utf-8')
      .send(asset('style.css'));
  });

  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());

  app.get('/healthz', async (_request, reply) => {
    const ready = ctx.registry.providers.filter(
      (provider) => provider.enabled && provider.keys.hasUsableKey(),
    ).length;
    return reply.send({
      ok: true,
      version: APP_VERSION,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      providersReady: ready,
      providersTotal: ctx.registry.providers.length,
    });
  });

  app.get(
    '/admin/api/channels',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.header('cache-control', 'no-store').send({
        editable: Boolean(ctx.configPath),
        channels: ctx.registry.providers.map((provider) =>
          channelView(provider, ctx.supervisor.snapshot(provider.id)),
        ),
      });
    },
  );

  app.post(
    '/admin/api/maintenance/probe',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      await ctx.supervisor.probeAll();
      const providers: Record<string, ProviderMonitorSnapshot> = {};
      for (const provider of ctx.registry.providers) {
        providers[provider.id] = ctx.supervisor.snapshot(provider.id);
      }
      return reply.send({ ok: true, providers });
    },
  );

  app.post(
    '/admin/api/maintenance/keepalive',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      await ctx.supervisor.runKeepaliveAll(true);
      const providers: Record<string, ProviderMonitorSnapshot> = {};
      for (const provider of ctx.registry.providers) {
        providers[provider.id] = ctx.supervisor.snapshot(provider.id);
      }
      return reply.send({ ok: true, providers });
    },
  );

  app.post(
    '/admin/api/channels',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!ctx.configPath) {
        return reply.code(400).send({
          error: { message: '当前服务未加载配置文件路径，无法编辑渠道', type: 'invalid_request_error' },
        });
      }
      try {
        const input = parseChannelInput(request.body);
        const result = await upsertChannel(ctx.configPath, input, 'create');
        await ctx.applyConfig(result.config);
        return reply.send({ ok: true, warnings: result.warnings });
      } catch (error) {
        return channelError(reply, error);
      }
    },
  );

  app.put(
    '/admin/api/channels/:id',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!ctx.configPath) {
        return reply.code(400).send({
          error: { message: '当前服务未加载配置文件路径，无法编辑渠道', type: 'invalid_request_error' },
        });
      }
      const { id } = request.params as { id?: string };
      if (!id) {
        return reply.code(400).send({ error: { message: '缺少渠道 id', type: 'invalid_request_error' } });
      }
      try {
        const input = parseChannelInput(request.body);
        if (input.id !== id) {
          return reply.code(400).send({
            error: { message: '路径中的渠道 id 与表单不一致', type: 'invalid_request_error' },
          });
        }
        const result = await upsertChannel(ctx.configPath, input, 'update');
        await ctx.applyConfig(result.config);
        return reply.send({ ok: true, warnings: result.warnings });
      } catch (error) {
        return channelError(reply, error);
      }
    },
  );

  app.delete(
    '/admin/api/channels/:id',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!ctx.configPath) {
        return reply.code(400).send({
          error: { message: '当前服务未加载配置文件路径，无法编辑渠道', type: 'invalid_request_error' },
        });
      }
      const { id } = request.params as { id?: string };
      if (!id) {
        return reply.code(400).send({ error: { message: '缺少渠道 id', type: 'invalid_request_error' } });
      }
      try {
        const result = await deleteChannel(ctx.configPath, id);
        await ctx.applyConfig(result.config);
        return reply.send({ ok: true, warnings: result.warnings });
      } catch (error) {
        return channelError(reply, error);
      }
    },
  );

  app.get(
    '/admin/api/questions',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const questions: PendingQuestionView[] = [];
      for (const provider of ctx.registry.providers) {
        const adapter = openCodeAdapterOf(provider);
        if (adapter) questions.push(...adapter.listPendingQuestions());
      }
      return reply.header('cache-control', 'no-store').send({ questions });
    },
  );

  app.post(
    '/admin/api/questions/:id/answer',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id?: string };
      if (!id) {
        return reply.code(400).send({
          error: { message: '缺少提问 id', type: 'invalid_request_error' },
        });
      }
      try {
        for (const provider of ctx.registry.providers) {
          const adapter = openCodeAdapterOf(provider);
          if (!adapter) continue;
          if (!adapter.listPendingQuestions().some((item) => item.id === id)) continue;
          await adapter.answerQuestion(id, request.body);
          return reply.send({ ok: true });
        }
        return reply.code(404).send({
          error: { message: '提问不存在或已处理', type: 'not_found_error' },
        });
      } catch (error) {
        return channelError(reply, error);
      }
    },
  );

  app.get(
    '/admin/api/export',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const file = join(tmpdir(), `code2api-backup-${Date.now()}.db`);
      try {
        ctx.store.backupTo(file);
      } catch (error) {
        return reply.code(500).send({
          error: {
            message: `导出数据库失败: ${(error as Error).message}`,
            type: 'internal_error',
          },
        });
      }
      const stream = createReadStream(file);
      stream.once('close', () => {
        try {
          unlinkSync(file);
        } catch {
          // ignore cleanup failure
        }
      });
      return reply
        .header(
          'content-disposition',
          `attachment; filename="code2api-${new Date().toISOString().slice(0, 10)}.db"`,
        )
        .header('content-type', 'application/octet-stream')
        .send(stream);
    },
  );

  app.get(
    '/admin/api/overview',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const range = parseRange((request.query as Record<string, unknown>).range);
      const totals = ctx.store.totals(range.sinceMs);
      const perKey = ctx.store.providerKeyStats(range.sinceMs);
      const failuresPerKey = ctx.store.attemptFailureStats(range.sinceMs);
      const byKey = new Map<string, ProviderKeyStats>();
      for (const stat of perKey) byKey.set(statsKey(stat.provider, stat.keyLabel), stat);
      const byKeyFailures = new Map<string, number>();
      for (const stat of failuresPerKey) {
        byKeyFailures.set(statsKey(stat.provider, stat.keyLabel), stat.failures);
      }

      const providers = ctx.registry.providers.map((provider) => {
        const aggregate = emptyStats();
        const keys = provider.keys.snapshot().map((key) => {
          const requestStats = byKey.get(statsKey(provider.id, key.label)) ?? emptyStats();
          const failures = byKeyFailures.get(statsKey(provider.id, key.label)) ?? 0;
          const stat = { ...requestStats, errors: failures };
          aggregate.requests += stat.requests;
          aggregate.errors += stat.errors;
          aggregate.inputTokens += stat.inputTokens;
          aggregate.outputTokens += stat.outputTokens;
          aggregate.costUsd += stat.costUsd;
          return { ...key, stats: stat };
        });
        return {
          id: provider.id,
          type: provider.type,
          priority: provider.priority,
          enabled: provider.enabled,
          disabledReason: provider.disabledReason ?? null,
          models: provider.models.map((model) => ({
            id: model.id,
            upstream: model.upstream,
            contextWindow: model.contextWindow ?? null,
            capabilities: model.capabilities,
            source: model.source ?? 'config',
          })),
          keys,
          stats: aggregate,
        };
      });

      return reply.header('cache-control', 'no-store').send({
        server: {
          version: APP_VERSION,
          uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
          startedAt: ctx.startedAt,
          host: ctx.config.server.host,
          port: ctx.config.server.port,
          clientAuth: ctx.config.server.clientKeys.length > 0,
          concurrency: ctx.limiter.snapshot(),
        },
        range,
        totals: {
          ...totals,
          successRate: totals.requests > 0 ? totals.ok / totals.requests : null,
        },
        providers,
      });
    },
  );

  app.get(
    '/admin/api/requests',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const range = parseRange(query.range);
      const limitRaw = Number(query.limit ?? 100);
      const offsetRaw = Number(query.offset ?? 0);
      const requests = ctx.store.recentRequests({
        limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
        provider: typeof query.provider === 'string' && query.provider ? query.provider : undefined,
        status: typeof query.status === 'string' && query.status ? query.status : undefined,
        model: typeof query.model === 'string' && query.model ? query.model : undefined,
        sinceMs: range.sinceMs,
      });
      return reply.header('cache-control', 'no-store').send({ range, requests });
    },
  );

  app.get(
    '/admin/api/models',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const models = ctx.registry.modelEntries().map((entry) => ({
        id: entry.model.id,
        provider: entry.provider.id,
        providerType: entry.provider.type,
        enabled: entry.provider.enabled,
        upstream: entry.model.upstream,
        contextWindow: entry.model.contextWindow ?? null,
        maxOutputTokens: entry.model.maxOutputTokens ?? null,
        capabilities: entry.model.capabilities,
        pricing: entry.model.pricing ?? null,
        reasoningEffort: entry.model.reasoningEffort ?? null,
        source: entry.model.source ?? 'config',
      }));
      return reply
        .header('cache-control', 'no-store')
        .send({ models, sync: ctx.catalog.snapshot() });
    },
  );
}
