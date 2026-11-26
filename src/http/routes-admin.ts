import { readFileSync, createReadStream, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { APP_VERSION } from '../config.js';
import {
  buildProvider,
  deleteChannel,
  parseChannelInput,
  parsePrivacyInput,
  parseRetryInput,
  updatePrivacyPolicy,
  updateRetryPolicy,
  upsertChannel,
} from '../core/config-editor.js';
import { maskKey } from '../core/keys.js';
import { detectQoderInstall, qoderCliLoginHint } from '../core/qoder-install.js';
import { guessReasoningModel, matchModelPrefix, withTimeout } from '../core/model-catalog.js';
import { isSecretEncryptionAvailable, secretBackendLabel } from '../core/secrets.js';
import type { ProviderMonitorSnapshot } from '../core/pool-supervisor.js';
import { GatewayError } from '../errors.js';
import { OpenCodeAdapter, type PendingQuestionView } from '../providers/opencode.js';
import { QoderAdapter, probeQoderModels } from '../providers/qoder.js';
import { createAdapter, type ProviderRuntime } from '../providers/registry.js';
import { ZcodeAdapter } from '../providers/zcode.js';
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

/** 任何实现了 listPendingQuestions/answerQuestion 的适配器都可参与提问面板。 */
function questionAdapterOf(provider: ProviderRuntime):
  | {
      listPendingQuestions: () => Array<Record<string, unknown>>;
      answerQuestion: (id: string, raw: unknown) => Promise<void>;
    }
  | null {
  const adapter = provider.adapter as unknown as Record<string, unknown>;
  if (
    adapter &&
    typeof adapter.listPendingQuestions === 'function' &&
    typeof adapter.answerQuestion === 'function'
  ) {
    return adapter as {
      listPendingQuestions: () => Array<Record<string, unknown>>;
      answerQuestion: (id: string, raw: unknown) => Promise<void>;
    };
  }
  return null;
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
            encrypted: Boolean(key.keyEnc),
            keyError: key.keyError ?? null,
            status:
              state?.status ??
              (key.missingEnv
                ? 'missing_env'
                : key.keyError
                  ? 'error'
                  : 'ready'),
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
    freeOnly: config.type === 'openai-compatible' ? config.freeOnly : null,
    reasoningField: config.type === 'openai-compatible' ? config.reasoningField ?? null : null,
    reasoningOffField:
      config.type === 'openai-compatible' ? config.reasoningOffField ?? null : null,
    userAgent: config.type === 'openai-compatible' ? config.userAgent ?? null : null,
    modelsUrl: config.type === 'openai-compatible' ? config.modelsUrl ?? null : null,
    sessionHeader:
      config.type === 'openai-compatible' ? config.sessionHeader ?? null : null,
    modelPrefixes:
      config.type === 'openai-compatible' ? config.modelPrefixes ?? null : null,
    opencode:
      config.type === 'opencode'
        ? {
            flavor: config.flavor,
            codeartsDataDir: config.codeartsDataDir ?? null,
            modelFilter: config.modelFilter,
            modelPrefixes: config.modelPrefixes ?? null,
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
            firstByteTimeoutMs: config.firstByteTimeoutMs,
            streamHeartbeatMs: config.streamHeartbeatMs,
            eventDebugFrames: config.eventDebugFrames,
            baseUrl: config.baseUrl ?? null,
            worker: adapter?.workerSnapshot() ?? null,
            pool: adapter?.poolSnapshot() ?? null,
          }
        : null,
    zcode:
      config.type === 'zcode'
        ? {
            command: config.command,
            args: config.args,
            env: config.env,
            workspace: config.workspace,
            workspaceRoots: config.workspaceRoots,
            mode: config.mode,
            maxWorkers: config.maxWorkers,
            maxConcurrentSessions: config.maxConcurrentSessions,
            idleTtlMs: config.idleTtlMs,
            worker: (provider.adapter as ZcodeAdapter).workerSnapshot(),
            pool: (provider.adapter as ZcodeAdapter).poolSnapshot(),
          }
        : null,
    qoder:
      config.type === 'qoder'
        ? {
            command: config.command,
            args: config.args,
            env: config.env,
            workspace: config.workspace,
            workspaceRoots: config.workspaceRoots,
            mode: config.mode,
            maxWorkers: config.maxWorkers,
            maxConcurrentSessions: config.maxConcurrentSessions,
            idleTtlMs: config.idleTtlMs,
            worker: (provider.adapter as QoderAdapter).workerSnapshot(),
            pool: (provider.adapter as QoderAdapter).poolSnapshot(),
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
        secretStorage: {
          available: isSecretEncryptionAvailable(),
          backend: secretBackendLabel(),
        },
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

  // 立即解除所有渠道密钥的冷却（含连续失败计数），用于上游限流恢复后手动放行。
  app.post(
    '/admin/api/maintenance/clear-cooldowns',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      let cleared = 0;
      for (const provider of ctx.registry.providers) {
        cleared += provider.keys.clearCooldowns();
      }
      return reply.send({ ok: true, cleared });
    },
  );

  // 面板「检测本机 Qoder」：只读扫描安装目录，返回可直接填入表单的 command/args/env。
  app.get(
    '/admin/api/qoder/detect',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const found = detectQoderInstall();
      if (!found) {
        return reply.code(404).send({
          error: {
            message:
              '未找到本机 Qoder 安装；请在面板手工填写 Qoder.exe 与 qoder-worker-runtime.obf.mjs 路径',
            type: 'invalid_request_error',
            code: 'qoder_not_found',
          },
        });
      }
      return reply.send({ ok: true, ...found, cliLoginHint: qoderCliLoginHint() });
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

  // 用面板表单里的草稿配置临时探测上游模型目录；只读预览，不写 YAML、不进 registry。
  app.post(
    '/admin/api/channels/probe-models',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const input = parseChannelInput(request.body);
        const existing = ctx.config.providers.find((provider) => provider.id === input.id);
        const config = buildProvider(input, existing);
        if (config.type === 'mock') {
          throw new GatewayError('mock 渠道无需探测上游模型', {
            status: 400,
            type: 'invalid_request_error',
            code: 'config_invalid',
          });
        }
        if (config.type === 'zcode') {
          throw new GatewayError(
            `zcode 渠道没有模型目录可探测（CLI 协议不支持），请手工填写 providerId/modelId`,
            { status: 400, type: 'invalid_request_error', code: 'config_invalid' },
          );
        }
        if (config.type === 'qoder') {
          // qoder 的模型目录在 daemon 侧（daemon.get_models）：临时拉起 CLI 读一次，不建会话、不耗模型额度。
          const infos = await withTimeout(
            probeQoderModels(config, 20000),
            120000,
            `qoder 渠道 ${config.id} 模型探测`,
          ).catch((error: unknown) => {
            throw new GatewayError(`qoder 模型探测失败：${(error as Error).message}`, {
              status: 502,
              type: 'upstream_error',
            });
          });
          return reply.send({
            ok: true,
            models: infos.map((info) => ({
              // 对外名用 runtime 的 modelId；displayName 只做候选按钮的标签。
              id: info.id,
              upstream: info.id,
              label:
                info.displayName && info.displayName !== info.id
                  ? `${info.displayName}（${info.id}）`
                  : info.id,
              contextWindow: info.contextWindow ?? null,
              maxOutputTokens: info.maxOutputTokens ?? null,
              capabilities: { tools: true, vision: info.vision, reasoning: info.reasoning },
              default: info.isDefault,
            })),
          });
        }
        const adapter = createAdapter(config, ctx.store);
        try {
          if (config.type === 'opencode') {
            // 可能需要现场拉起 opencode CLI，超时给足。
            const infos = await withTimeout(
              (adapter as OpenCodeAdapter).listModelInfos(),
              60000,
              `opencode 渠道 ${config.id} 模型探测`,
            );
            return reply.send({
              ok: true,
              models: infos.map((info) => {
                // 与模型目录同步一致：按渠道 model_prefixes 给候选对外名加前缀。
                const prefix = matchModelPrefix(config.modelPrefixes, info.id, info.upstream);
                return {
                  id: prefix ? `${prefix}${info.id}` : info.id,
                  upstream: info.upstream,
                  contextWindow: info.contextWindow ?? null,
                  maxOutputTokens: info.maxOutputTokens ?? null,
                  capabilities: info.capabilities,
                  pricing: info.pricing ?? null,
                };
              }),
            });
          }
          const key = config.keys.find((item) => item.key !== null)?.key ?? null;
          const timeoutMs = Math.min(config.timeouts.connectMs, 15000);
          const infos = await withTimeout(
            adapter.listModels!(key, timeoutMs),
            timeoutMs + 5000,
            `渠道 ${config.id} 模型探测`,
          );
          const catalogConfig = ctx.config.catalog;
          return reply.send({
            ok: true,
            models: infos.map((info) => {
              // 与模型目录同步保持一致：上游未声明能力时按 catalog 策略兜底。
              const detected = info.capabilities ?? {};
              let reasoning = detected.reasoning;
              if (reasoning === undefined) {
                reasoning = catalogConfig.strictCapabilities
                  ? catalogConfig.reasoningHints && guessReasoningModel(info.id)
                  : true;
              }
              const prefix = matchModelPrefix(config.modelPrefixes, info.id, info.id);
              return {
                id: prefix ? `${prefix}${info.id}` : info.id,
                upstream: info.id,
                contextWindow: info.contextWindow ?? null,
                maxOutputTokens: info.maxOutputTokens ?? null,
                capabilities: {
                  tools: detected.tools ?? true,
                  vision: detected.vision ?? false,
                  reasoning,
                },
                pricing: null,
              };
            }),
          });
        } catch (error) {
          throw new GatewayError(`探测上游模型失败：${(error as Error).message}`, {
            status: 502,
            type: 'upstream_error',
          });
        } finally {
          try {
            await adapter.close?.();
          } catch {
            // 清理失败不影响探测结果
          }
        }
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
      const questions: Array<Record<string, unknown>> = [];
      for (const provider of ctx.registry.providers) {
        const adapter = questionAdapterOf(provider);
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
          const adapter = questionAdapterOf(provider);
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
        reasoningVariants: entry.model.reasoningVariants ?? null,
        source: entry.model.source ?? 'config',
      }));
      return reply
        .header('cache-control', 'no-store')
        .send({ models, sync: ctx.catalog.snapshot() });
    },
  );

  app.get(
    '/admin/api/retry',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply
        .header('cache-control', 'no-store')
        .send({
          editable: Boolean(ctx.configPath),
          retry: ctx.config.routing.retry,
        });
    },
  );

  app.put(
    '/admin/api/retry',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!ctx.configPath) {
        return reply.code(400).send({
          error: { message: '当前服务未加载配置文件路径，无法编辑重试配置', type: 'invalid_request_error' },
        });
      }
      try {
        const input = parseRetryInput(request.body);
        const result = await updateRetryPolicy(ctx.configPath, input);
        ctx.applyRetryConfig(result.config);
        return reply.send({ ok: true, warnings: result.warnings });
      } catch (error) {
        return channelError(reply, error);
      }
    },
  );

  app.get(
    '/admin/api/privacy',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const range = parseRange(query.range);
      const limitRaw = Number(query.limit ?? 100);
      const snapshot = ctx.privacy.snapshot();
      return reply.header('cache-control', 'no-store').send({
        editable: Boolean(ctx.configPath),
        config: ctx.config.privacy,
        status: {
          ...snapshot,
          secretStorage: {
            available: isSecretEncryptionAvailable(),
            backend: secretBackendLabel(),
          },
        },
        totals: ctx.store.privacyEventTotals(range.sinceMs),
        events: ctx.store.recentPrivacyEvents({
          sinceMs: range.sinceMs,
          limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        }),
        vault: ctx.store.listPrivacyVault(100).map((row) => ({
          placeholder: row.placeholder,
          category: row.category,
          masked: row.masked,
          hits: row.hits,
          createdAt: row.createdAt,
          lastUsedAt: row.lastUsedAt,
        })),
      });
    },
  );

  app.put(
    '/admin/api/privacy',
    { preHandler: adminGuard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!ctx.configPath) {
        return reply.code(400).send({
          error: { message: '当前服务未加载配置文件路径，无法编辑隐私守卫', type: 'invalid_request_error' },
        });
      }
      try {
        const input = parsePrivacyInput(request.body);
        const result = await updatePrivacyPolicy(ctx.configPath, input);
        await ctx.applyConfig(result.config);
        return reply.send({ ok: true, warnings: result.warnings });
      } catch (error) {
        return channelError(reply, error);
      }
    },
  );
}
