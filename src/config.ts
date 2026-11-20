import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export const APP_VERSION = '0.1.0';

export interface ModelPricing {
  inputPerMtok?: number;
  outputPerMtok?: number;
  cacheReadPerMtok?: number;
  cacheWritePerMtok?: number;
}

/**
 * 推理强度取值。OpenAI 标准为 low/medium/high，部分上游支持 xhigh/max/minimal
 * 等自定义档位；网关不做枚举限制，原样透传给上游。
 */
export type ReasoningEffort = string;

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

export interface ModelConfig {
  id: string;
  upstream: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  /** 该模型对外默认注入的推理强度（仅对 reasoning 模型生效）。 */
  reasoningEffort?: ReasoningEffort;
  /** 模型来源：手工配置 or 上游目录同步。 */
  source?: 'config' | 'upstream';
}

export interface KeyConfig {
  label: string;
  key: string | null;
  keyEnv?: string;
  missingEnv?: string;
}

export interface Timeouts {
  connectMs: number;
  ttfbMs: number;
  idleMs: number;
  totalMs: number;
}

export interface ProviderBase {
  id: string;
  priority: number;
  enabled: boolean;
  models: ModelConfig[];
}

export interface MockProviderConfig extends ProviderBase {
  type: 'mock';
}

export interface QuotaConfig {
  enabled: boolean;
  url: string;
  intervalMs: number;
  timeoutMs: number;
  headers: Record<string, string>;
  remainingPath?: string;
  resetAtPath?: string;
  statusPath?: string;
}

export interface KeepaliveConfig {
  enabled: boolean;
  intervalMs: number;
  model?: string;
  maxTokens: number;
  prompt: string;
}

export interface HealthConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
}

export interface OpenAIProviderConfig extends ProviderBase {
  type: 'openai-compatible';
  baseUrl: string;
  authHeader: 'bearer' | 'x-api-key';
  tokenLimitField: 'max_tokens' | 'max_completion_tokens';
  sendStreamOptions: boolean;
  extraHeaders: Record<string, string>;
  timeouts: Timeouts;
  keys: KeyConfig[];
  /** 是否从上游 /models 拉取模型目录并合并。 */
  syncModels: boolean;
  /** 对 reasoning 模型默认注入的推理强度（客户端未指定时）。 */
  defaultReasoningEffort?: ReasoningEffort;
  /** Anthropic thinking.budget_tokens 透传到上游时的字段路径（支持点号，如 reasoning.max_tokens）。 */
  reasoningBudgetField?: string;
  quota?: QuotaConfig;
  keepalive?: KeepaliveConfig;
}

export interface OpenCodeProviderConfig extends ProviderBase {
  type: 'opencode';
  command: string;
  args: string[];
  workspace: string;
  workspaceRoots: string[];
  hostname: string;
  port?: number;
  baseUrl?: string;
  username: string;
  passwordEnv: string;
  agent: string;
  permissionMode: 'ask' | 'allow' | 'deny';
  autoModels: boolean;
  maxWorkers: number;
  maxConcurrentSessions: number;
  idleTtlMs: number;
  memoryBudgetMb: number;
  questionTimeoutMs: number;
  taskTimeoutMs: number;
  startupTimeoutMs: number;
  restartBudget: number;
}

export type ProviderConfig = MockProviderConfig | OpenAIProviderConfig | OpenCodeProviderConfig;

export interface CooldownConfig {
  authMs: number;
  rateLimitMs: number;
  paymentMs: number;
  serverMs: number;
  networkMs: number;
  emptyStreamMs: number;
  maxMs: number;
}

export interface ResolvedConfig {
  server: {
    host: string;
    port: number;
    bodyLimitMb: number;
    clientKeys: string[];
    maxConcurrency: number;
    maxQueueWaitMs: number;
  };
  admin: {
    token: string;
  };
  storage: {
    path: string;
  };
  routing: {
    maxAttempts: number;
    cooldowns: CooldownConfig;
    modelAliases: Record<string, string>;
    modelBlacklist: string[];
  };
  anthropic: {
    emitThinking: boolean;
  };
  catalog: CatalogConfig;
  health: HealthConfig;
  providers: ProviderConfig[];
}

export interface CatalogConfig {
  /** 是否启用模型目录同步（启动 + 定时）。 */
  syncEnabled: boolean;
  /** 启动时是否立即同步一次。 */
  syncOnStart: boolean;
  /** 定时同步间隔（毫秒）。 */
  syncIntervalMs: number;
  /** 同步时是否按模型名推断 reasoning 能力。 */
  reasoningHints: boolean;
}

const pricingSchema = z.object({
  input_per_mtok: z.number().nonnegative().optional(),
  output_per_mtok: z.number().nonnegative().optional(),
  cache_read_per_mtok: z.number().nonnegative().optional(),
  cache_write_per_mtok: z.number().nonnegative().optional(),
});

const capabilitiesSchema = z
  .object({
    tools: z.boolean().default(true),
    vision: z.boolean().default(false),
    reasoning: z.boolean().default(false),
  })
  .default({});

const reasoningEffortSchema = z.string().trim().min(1).max(32);

const modelSchema = z.object({
  id: z.string().min(1),
  upstream: z.string().min(1).optional(),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  capabilities: capabilitiesSchema,
  pricing: pricingSchema.optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
});

const keySchema = z
  .object({
    label: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    key_env: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.key) !== Boolean(v.key_env), {
    message: 'key 与 key_env 必须二选一',
  });

const timeoutsSchema = z
  .object({
    connect_ms: z.number().int().positive().default(30000),
    ttfb_ms: z.number().int().positive().default(60000),
    idle_ms: z.number().int().positive().default(120000),
    total_ms: z.number().int().positive().default(600000),
  })
  .default({});

const providerBase = {
  id: z.string().min(1),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
  models: z.array(modelSchema).min(1),
};

const mockProviderSchema = z.object({
  ...providerBase,
  type: z.literal('mock'),
});

const quotaSchema = z
  .object({
    enabled: z.boolean().default(true),
    url: z.string().url(),
    interval_ms: z.number().int().positive().default(60000),
    timeout_ms: z.number().int().positive().default(10000),
    headers: z.record(z.string()).default({}),
    remaining_path: z.string().min(1).optional(),
    reset_at_path: z.string().min(1).optional(),
    status_path: z.string().min(1).optional(),
  })
  .optional();

const keepaliveSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval_ms: z.number().int().positive().default(300000),
    model: z.string().min(1).optional(),
    max_tokens: z.number().int().positive().default(8),
    prompt: z.string().default('ping'),
  })
  .optional();

const openAIProviderSchema = z.object({
  ...providerBase,
  type: z.literal('openai-compatible'),
  base_url: z.string().url(),
  auth_header: z.enum(['bearer', 'x-api-key']).default('bearer'),
  token_limit_field: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  send_stream_options: z.boolean().default(true),
  extra_headers: z.record(z.string()).default({}),
  timeouts: timeoutsSchema,
  keys: z.array(keySchema).default([]),
  sync_models: z.boolean().default(true),
  default_reasoning_effort: reasoningEffortSchema.optional(),
  reasoning_budget_field: z.string().min(1).max(128).optional(),
  quota: quotaSchema,
  keepalive: keepaliveSchema,
});

const openCodeProviderSchema = z.object({
  ...providerBase,
  type: z.literal('opencode'),
  models: z.array(modelSchema).min(0),
  command: z.string().min(1).default('opencode'),
  args: z.array(z.string()).default([]),
  workspace: z.string().min(1).default('./workspace'),
  workspace_roots: z.array(z.string().min(1)).default([]),
  hostname: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).optional(),
  base_url: z.string().url().optional(),
  username: z.string().default('opencode'),
  password_env: z.string().default('OPENCODE_SERVER_PASSWORD'),
  agent: z.string().default('build'),
  permission_mode: z.enum(['ask', 'allow', 'deny']).default('ask'),
  auto_models: z.boolean().default(true),
  max_workers: z.number().int().min(1).max(8).default(1),
  max_concurrent_sessions: z.number().int().min(1).max(64).default(4),
  idle_ttl_ms: z.number().int().positive().default(900000),
  memory_budget_mb: z.number().int().min(0).default(0),
  question_timeout_ms: z.number().int().positive().default(600000),
  task_timeout_ms: z.number().int().positive().default(1800000),
  startup_timeout_ms: z.number().int().positive().default(60000),
  restart_budget: z.number().int().min(0).default(3),
});

const providerSchema = z.discriminatedUnion('type', [
  mockProviderSchema,
  openAIProviderSchema,
  openCodeProviderSchema,
]);

const cooldownsSchema = z
  .object({
    auth_ms: z.number().int().positive().default(600000),
    rate_limit_ms: z.number().int().positive().default(60000),
    payment_ms: z.number().int().positive().default(1800000),
    server_ms: z.number().int().positive().default(15000),
    network_ms: z.number().int().positive().default(10000),
    empty_stream_ms: z.number().int().positive().default(5000),
    max_ms: z.number().int().positive().default(1800000),
  })
  .default({});

const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(0).max(65535).default(8787),
      body_limit_mb: z.number().int().positive().default(50),
      client_keys: z.array(z.string().min(1)).default([]),
      max_concurrency: z.number().int().min(0).max(1024).default(32),
      max_queue_wait_ms: z.number().int().min(100).max(3600000).default(120000),
    })
    .default({}),
  admin: z
    .object({
      token: z.string().default(''),
    })
    .default({}),
  storage: z
    .object({
      path: z.string().default('./data/gateway.db'),
    })
    .default({}),
  routing: z
    .object({
      max_attempts: z.number().int().min(1).max(20).default(6),
      cooldowns: cooldownsSchema,
      model_aliases: z.record(z.string().min(1)).default({}),
      model_blacklist: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  anthropic: z
    .object({
      emit_thinking: z.boolean().default(false),
    })
    .default({}),
  catalog: z
    .object({
      sync_enabled: z.boolean().default(true),
      sync_on_start: z.boolean().default(true),
      sync_interval_ms: z.number().int().positive().default(3600000),
      reasoning_hints: z.boolean().default(true),
    })
    .default({}),
  health: z
    .object({
      enabled: z.boolean().default(true),
      interval_ms: z.number().int().positive().default(300000),
      timeout_ms: z.number().int().positive().default(10000),
    })
    .default({}),
  providers: z.array(providerSchema).min(1),
});

function toModel(m: z.infer<typeof modelSchema>): ModelConfig {
  return {
    id: m.id,
    upstream: m.upstream ?? m.id,
    contextWindow: m.context_window,
    maxOutputTokens: m.max_output_tokens,
    capabilities: {
      tools: m.capabilities.tools,
      vision: m.capabilities.vision,
      reasoning: m.capabilities.reasoning,
    },
    pricing: m.pricing
      ? {
          inputPerMtok: m.pricing.input_per_mtok,
          outputPerMtok: m.pricing.output_per_mtok,
          cacheReadPerMtok: m.pricing.cache_read_per_mtok,
          cacheWritePerMtok: m.pricing.cache_write_per_mtok,
        }
      : undefined,
    reasoningEffort: m.reasoning_effort,
    source: 'config',
  };
}

function resolveKeys(
  providerId: string,
  keys: z.infer<typeof keySchema>[],
): KeyConfig[] {
  const used = new Set<string>();
  return keys.map((k, index) => {
    let label = k.label ?? `k${index + 1}`;
    if (used.has(label)) {
      let n = 2;
      while (used.has(`${label}#${n}`)) n += 1;
      label = `${label}#${n}`;
    }
    used.add(label);

    if (k.key_env) {
      const value = process.env[k.key_env];
      if (!value) {
        return { label, key: null, keyEnv: k.key_env, missingEnv: k.key_env };
      }
      return { label, key: value, keyEnv: k.key_env };
    }
    return { label, key: k.key ?? null };
  });
}

export function parseConfig(raw: unknown): ResolvedConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`配置校验失败:\n${details}`);
  }
  const cfg = parsed.data;

  const providers: ProviderConfig[] = cfg.providers.map((p) => {
    const base = {
      id: p.id,
      priority: p.priority,
      enabled: p.enabled,
      models: p.models.map(toModel),
    };
    if (p.type === 'mock') {
      return { ...base, type: 'mock' };
    }
    if (p.type === 'opencode') {
      return {
        ...base,
        type: 'opencode',
        command: p.command,
        args: p.args,
        workspace: p.workspace,
        workspaceRoots: p.workspace_roots,
        hostname: p.hostname,
        port: p.port,
        baseUrl: p.base_url?.replace(/\/+$/, ''),
        username: p.username,
        passwordEnv: p.password_env,
        agent: p.agent,
        permissionMode: p.permission_mode,
        autoModels: p.auto_models,
        maxWorkers: p.max_workers,
        maxConcurrentSessions: p.max_concurrent_sessions,
        idleTtlMs: p.idle_ttl_ms,
        memoryBudgetMb: p.memory_budget_mb,
        questionTimeoutMs: p.question_timeout_ms,
        taskTimeoutMs: p.task_timeout_ms,
        startupTimeoutMs: p.startup_timeout_ms,
        restartBudget: p.restart_budget,
      };
    }
    return {
      ...base,
      type: 'openai-compatible',
      baseUrl: p.base_url.replace(/\/+$/, ''),
      authHeader: p.auth_header,
      tokenLimitField: p.token_limit_field,
      sendStreamOptions: p.send_stream_options,
      extraHeaders: p.extra_headers,
      timeouts: {
        connectMs: p.timeouts.connect_ms,
        ttfbMs: p.timeouts.ttfb_ms,
        idleMs: p.timeouts.idle_ms,
        totalMs: p.timeouts.total_ms,
      },
      keys: resolveKeys(p.id, p.keys),
      syncModels: p.sync_models,
      defaultReasoningEffort: p.default_reasoning_effort,
      reasoningBudgetField: p.reasoning_budget_field,
      quota: p.quota
        ? {
            enabled: p.quota.enabled,
            url: p.quota.url,
            intervalMs: p.quota.interval_ms,
            timeoutMs: p.quota.timeout_ms,
            headers: p.quota.headers,
            remainingPath: p.quota.remaining_path,
            resetAtPath: p.quota.reset_at_path,
            statusPath: p.quota.status_path,
          }
        : undefined,
      keepalive: p.keepalive
        ? {
            enabled: p.keepalive.enabled,
            intervalMs: p.keepalive.interval_ms,
            model: p.keepalive.model,
            maxTokens: p.keepalive.max_tokens,
            prompt: p.keepalive.prompt,
          }
        : undefined,
    };
  });

  const seenIds = new Set<string>();
  for (const provider of providers) {
    if (seenIds.has(provider.id)) {
      throw new Error(`配置校验失败:\nproviders: 渠道 id 重复: ${provider.id}`);
    }
    seenIds.add(provider.id);
    if (provider.type === 'opencode' && !provider.autoModels && provider.models.length === 0) {
      throw new Error(
        `配置校验失败:\nproviders: opencode 渠道 ${provider.id} 关闭自动发现后必须手工配置模型`,
      );
    }
  }

  return {
    server: {
      host: cfg.server.host,
      port: cfg.server.port,
      bodyLimitMb: cfg.server.body_limit_mb,
      clientKeys: cfg.server.client_keys,
      maxConcurrency: cfg.server.max_concurrency,
      maxQueueWaitMs: cfg.server.max_queue_wait_ms,
    },
    admin: { token: cfg.admin.token },
    storage: { path: cfg.storage.path },
    routing: {
      maxAttempts: cfg.routing.max_attempts,
      modelAliases: cfg.routing.model_aliases,
      modelBlacklist: cfg.routing.model_blacklist,
      cooldowns: {
        authMs: cfg.routing.cooldowns.auth_ms,
        rateLimitMs: cfg.routing.cooldowns.rate_limit_ms,
        paymentMs: cfg.routing.cooldowns.payment_ms,
        serverMs: cfg.routing.cooldowns.server_ms,
        networkMs: cfg.routing.cooldowns.network_ms,
        emptyStreamMs: cfg.routing.cooldowns.empty_stream_ms,
        maxMs: cfg.routing.cooldowns.max_ms,
      },
    },
    anthropic: { emitThinking: cfg.anthropic.emit_thinking },
    catalog: {
      syncEnabled: cfg.catalog.sync_enabled,
      syncOnStart: cfg.catalog.sync_on_start,
      syncIntervalMs: cfg.catalog.sync_interval_ms,
      reasoningHints: cfg.catalog.reasoning_hints,
    },
    health: {
      enabled: cfg.health.enabled,
      intervalMs: cfg.health.interval_ms,
      timeoutMs: cfg.health.timeout_ms,
    },
    providers,
  };
}

export function loadConfig(path: string): ResolvedConfig {
  const absolute = resolve(process.cwd(), path);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new Error(`无法读取配置文件 ${absolute}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new Error(`配置文件 YAML 解析失败 ${absolute}: ${(error as Error).message}`);
  }
  return parseConfig(raw);
}
