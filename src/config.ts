import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { tryDecryptSecret } from './core/secrets.js';

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
  /** opencode 渠道：reasoning effort 到会话 variant 的映射（自动发现时填充）。 */
  reasoningVariants?: Record<string, string>;
  /** 模型来源：手工配置 or 上游目录同步。 */
  source?: 'config' | 'upstream';
}

export interface KeyConfig {
  label: string;
  key: string | null;
  keyEnv?: string;
  missingEnv?: string;
  /** 加密落盘的密文（DPAPI 或 AES-GCM）；保存时原样写回，不解密后重写明文。 */
  keyEnc?: string;
  /** 密文解密失败原因（换机器/换用户/主密钥不匹配）。 */
  keyError?: string;
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
  /** 上游请求使用的 User-Agent；留空用 code2api/<version>。 */
  userAgent?: string;
  /** 模型目录地址覆盖（默认 `${baseUrl}/models`），用于 chat 与 models 路径不同的上游。 */
  modelsUrl?: string;
  /**
   * 按会话注入的请求头名（如 x-opencode-session）。值优先取客户端会话 id，
   * 缺省时用首条用户消息指纹生成，保证同一会话跨轮稳定。
   */
  sessionHeader?: string;
  /**
   * 自动发现模型的对外名前缀规则（glob → 前缀）：模式匹配裸 modelID 或
   * providerID/modelID（与 model_filter 同语义），如 { "opencode-go/*": "Go/" }
   * 把订阅渠道模型同步为 Go/<modelID>。upstream 保持原始名；手工 models 不受影响。
   */
  modelPrefixes?: Record<string, string>;
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
  /** 上游风味：opencode 原版；kilo = KiloDesktop 内置 CLI；codearts = CodeArts Agent IDE 内核（旧版 opencode API，外部模式自动发现）。 */
  flavor: 'opencode' | 'kilo' | 'codearts';
  /** codearts 风味：IDE 内核数据目录（默认 ~/.codeartsdoer/codearts-data），用于发现端口与解密服务口令。 */
  codeartsDataDir?: string;
  /** 自动发现的模型 id 白名单（glob，如 *:free）；空数组 = 不过滤。手工 models 不受影响。 */
  modelFilter: string[];
  /**
   * 自动发现模型的对外名前缀规则（glob → 前缀）：模式匹配裸 modelID 或
   * providerID/modelID（与 model_filter 同语义），如 { "opencode-go/*": "Go/" }
   * 把订阅渠道模型同步为 Go/<modelID>。upstream 保持原始名；手工 models 不受影响。
   */
  modelPrefixes?: Record<string, string>;
  command: string;
  args: string[];
  /** spawn 时附加的环境变量（如 CodeArts 内核用 OPENCODE_DATA_DIR 隔离数据目录）。 */
  env: Record<string, string>;
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
  /** 首包（首个上游事件）等待预算；超时即中断并明确报错，避免静默黑洞。0 = 关闭。 */
  firstByteTimeoutMs: number;
  /** 首包等待/上游静默期间的 SSE 心跳间隔（注释帧），防止客户端空闲超时。0 = 关闭。 */
  streamHeartbeatMs: number;
  /** /event 原始帧 debug 日志条数（每个事件流连接），0 = 关闭；日志会脱敏并截断。 */
  eventDebugFrames: number;
  startupTimeoutMs: number;
  restartBudget: number;
}

export interface ZcodeProviderConfig extends ProviderBase {
  type: 'zcode';
  command: string;
  args: string[];
  /** 追加到 CLI 子进程的环境变量（如 ZCODE_DATA_BASE_DIR / ZCODE_CREDENTIAL_SECRET_FILE）。 */
  env: Record<string, string>;
  workspace: string;
  workspaceRoots: string[];
  /** 传给 zcode 会话的权限模式（zcode: plan/build/edit/yolo/guarded）。 */
  mode: 'plan' | 'build' | 'edit' | 'yolo' | 'guarded';
  maxWorkers: number;
  maxConcurrentSessions: number;
  idleTtlMs: number;
  questionTimeoutMs: number;
  taskTimeoutMs: number;
  startupTimeoutMs: number;
  restartBudget: number;
}

export interface QoderProviderConfig extends ProviderBase {
  type: 'qoder';
  command: string;
  args: string[];
  /** 追加到 CLI 子进程的环境变量（如 ELECTRON_RUN_AS_NODE / QODER_PERSONAL_ACCESS_TOKEN）。 */
  env: Record<string, string>;
  workspace: string;
  workspaceRoots: string[];
  /** 传给 qoder 会话的权限模式（CLI 原生枚举）。 */
  mode: 'default' | 'accept_edits' | 'dont_ask' | 'plan' | 'bypass_permissions' | 'auto';
  maxWorkers: number;
  maxConcurrentSessions: number;
  idleTtlMs: number;
  questionTimeoutMs: number;
  taskTimeoutMs: number;
  startupTimeoutMs: number;
  restartBudget: number;
}

export type ProviderConfig =
  | MockProviderConfig
  | OpenAIProviderConfig
  | OpenCodeProviderConfig
  | ZcodeProviderConfig
  | QoderProviderConfig;

export interface CooldownConfig {
  authMs: number;
  rateLimitMs: number;
  paymentMs: number;
  serverMs: number;
  networkMs: number;
  emptyStreamMs: number;
  maxMs: number;
}

export type RetryCategory = 'rate_limit' | 'server' | 'timeout' | 'network' | 'empty_stream';

export interface RetryPolicyConfig {
  enabled: boolean;
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  retryOn: RetryCategory[];
  respectRetryAfter: boolean;
  maxTotalWaitMs: number;
}

/** 隐私守卫：出站令牌化 / 审计，入站还原。默认 off，不影响现有行为。 */
export interface PrivacyConfig {
  mode: 'off' | 'audit' | 'token';
  /** 身份类检测（用户名 / uid / 邮箱 / 用户目录路径），误报风险高于凭据类，单独开关。 */
  identity: boolean;
  /** 精确匹配网关自身配置里的密钥 / 口令（零误报）。 */
  protectConfigSecrets: boolean;
  providers: {
    /** 空 = 全部渠道生效。 */
    include: string[];
    exclude: string[];
  };
  /** 保管库条目保留天数（按最后使用时间）。 */
  tokenRetentionDays: number;
  maxVaultEntries: number;
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
    /** admin.token_enc 解密失败时的原因（此时会退化为临时口令）。 */
    tokenError?: string;
  };
  storage: {
    path: string;
  };
  routing: {
    maxAttempts: number;
    cooldowns: CooldownConfig;
    retry: RetryPolicyConfig;
    modelAliases: Record<string, string>;
    modelBlacklist: string[];
  };
  anthropic: {
    emitThinking: boolean;
  };
  catalog: CatalogConfig;
  health: HealthConfig;
  privacy: PrivacyConfig;
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
  /**
   * 严格能力模式：上游未声明能力时按保守值处理（reasoning=false）。
   * 默认 false：未声明则放行，由上游报错后自动降级。
   */
  strictCapabilities: boolean;
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
    key_enc: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      [v.key, v.key_env, v.key_enc].filter((item) => Boolean(item)).length === 1,
    {
      message: 'key / key_env / key_enc 必须三选一',
    },
  );

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

const modelPrefixesSchema = z
  .record(z.string())
  .refine(
    (value) =>
      Object.entries(value).every(
        ([pattern, prefix]) =>
          pattern.trim().length > 0 &&
          pattern.length <= 128 &&
          !/\s/.test(pattern) &&
          prefix.trim().length > 0 &&
          prefix.length <= 64 &&
          !/\s/.test(prefix),
      ),
    'model_prefixes 需为 glob → 前缀 的映射，键值均不能含空白',
  )
  .optional();

const openAIProviderSchema = z.object({
  ...providerBase,
  type: z.literal('openai-compatible'),
  base_url: z.string().url(),
  auth_header: z.enum(['bearer', 'x-api-key']).default('bearer'),
  token_limit_field: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  send_stream_options: z.boolean().default(true),
  extra_headers: z.record(z.string()).default({}),
  user_agent: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[\x20-\x7e]+$/, 'user_agent 仅支持可见 ASCII')
    .optional(),
  models_url: z.string().url().max(2048).optional(),
  session_header: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/, 'session_header 仅支持字母、数字和连字符')
    .optional(),
  model_prefixes: modelPrefixesSchema,
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
  flavor: z.enum(['opencode', 'kilo', 'codearts']).default('opencode'),
  codearts_data_dir: z.string().min(1).optional(),
  model_filter: z.array(z.string().min(1)).default([]),
  model_prefixes: modelPrefixesSchema,
  models: z.array(modelSchema).min(0),
  command: z.string().min(1).default('opencode'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
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
  question_timeout_ms: z.number().int().positive().default(7200000),
  task_timeout_ms: z.number().int().positive().default(1800000),
  first_byte_timeout_ms: z.number().int().min(0).default(120000),
  stream_heartbeat_ms: z.number().int().min(0).default(10000),
  event_debug_frames: z.number().int().min(0).max(1000).default(20),
  startup_timeout_ms: z.number().int().positive().default(60000),
  restart_budget: z.number().int().min(0).default(3),
});

const zcodeProviderSchema = z.object({
  ...providerBase,
  type: z.literal('zcode'),
  command: z.string().min(1).default('node'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).nullable().default({}),
  workspace: z.string().min(1).default('./workspace'),
  workspace_roots: z.array(z.string().min(1)).default([]),
  mode: z.enum(['plan', 'build', 'edit', 'yolo', 'guarded']).default('build'),
  max_workers: z.number().int().min(1).max(8).default(1),
  max_concurrent_sessions: z.number().int().min(1).max(64).default(2),
  idle_ttl_ms: z.number().int().positive().default(900000),
  question_timeout_ms: z.number().int().positive().default(7200000),
  task_timeout_ms: z.number().int().positive().default(1800000),
  startup_timeout_ms: z.number().int().positive().default(60000),
  restart_budget: z.number().int().min(0).default(3),
});

const qoderProviderSchema = z.object({
  ...providerBase,
  type: z.literal('qoder'),
  command: z.string().min(1).default('qodercli'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).nullable().default({}),
  workspace: z.string().min(1).default('./workspace'),
  workspace_roots: z.array(z.string().min(1)).default([]),
  mode: z
    .enum(['default', 'accept_edits', 'dont_ask', 'plan', 'bypass_permissions', 'auto'])
    .default('auto'),
  max_workers: z.number().int().min(1).max(8).default(1),
  max_concurrent_sessions: z.number().int().min(1).max(64).default(2),
  idle_ttl_ms: z.number().int().positive().default(900000),
  question_timeout_ms: z.number().int().positive().default(7200000),
  task_timeout_ms: z.number().int().positive().default(1800000),
  startup_timeout_ms: z.number().int().positive().default(90000),
  restart_budget: z.number().int().min(0).default(3),
});

const providerSchema = z.discriminatedUnion('type', [
  mockProviderSchema,
  openAIProviderSchema,
  openCodeProviderSchema,
  zcodeProviderSchema,
  qoderProviderSchema,
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

export const RETRY_CATEGORIES = [
  'rate_limit',
  'server',
  'timeout',
  'network',
  'empty_stream',
] as const;

const retrySchema = z
  .object({
    enabled: z.boolean().default(true),
    max_retries: z.number().int().min(0).max(20).default(5),
    initial_delay_ms: z.number().int().positive().default(500),
    max_delay_ms: z.number().int().positive().default(10000),
    jitter_ratio: z.number().min(0).max(1).default(0.1),
    retry_on: z.array(z.enum(RETRY_CATEGORIES)).default([...RETRY_CATEGORIES]),
    respect_retry_after: z.boolean().default(true),
    max_total_wait_ms: z.number().int().positive().default(120000),
  })
  .default({});

const privacySchema = z
  .object({
    mode: z.enum(['off', 'audit', 'token']).default('off'),
    identity: z.boolean().default(false),
    protect_config_secrets: z.boolean().default(true),
    providers: z
      .object({
        include: z.array(z.string().min(1)).default([]),
        exclude: z.array(z.string().min(1)).default([]),
      })
      .default({}),
    token_retention_days: z.number().int().min(1).max(3650).default(30),
    max_vault_entries: z.number().int().min(10).max(100000).default(5000),
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
      token_env: z.string().min(1).optional(),
      token_enc: z.string().min(1).optional(),
    })
    .default({})
    .refine(
      (v) =>
        [v.token, v.token_env, v.token_enc].filter((item) => Boolean(item))
          .length <= 1,
      { message: 'admin.token / token_env / token_enc 只能配置一个' },
    ),
  storage: z
    .object({
      path: z.string().default('./data/gateway.db'),
    })
    .default({}),
  routing: z
    .object({
      max_attempts: z.number().int().min(1).max(20).default(6),
      cooldowns: cooldownsSchema,
      retry: retrySchema,
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
    strict_capabilities: z.boolean().default(false),
  })
    .default({}),
  health: z
    .object({
      enabled: z.boolean().default(true),
      interval_ms: z.number().int().positive().default(300000),
      timeout_ms: z.number().int().positive().default(10000),
    })
    .default({}),
  privacy: privacySchema,
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
    if (k.key_enc) {
      const decrypted = tryDecryptSecret(k.key_enc);
      if (decrypted.value === undefined) {
        return { label, key: null, keyEnc: k.key_enc, keyError: decrypted.error };
      }
      return { label, key: decrypted.value, keyEnc: k.key_enc };
    }
    // 兼容历史明文 key；新写入的密钥一律走 key_enc 或 key_env。
    return { label, key: k.key ?? null };
  });
}

function resolveAdminToken(cfg: {
  admin: { token: string; token_env?: string; token_enc?: string };
}): { token: string; tokenError?: string } {
  if (cfg.admin.token_enc) {
    const decrypted = tryDecryptSecret(cfg.admin.token_enc);
    if (decrypted.value === undefined) {
      return { token: '', tokenError: decrypted.error };
    }
    return { token: decrypted.value };
  }
  if (cfg.admin.token_env) {
    return { token: process.env[cfg.admin.token_env] ?? '' };
  }
  return { token: cfg.admin.token };
}

/** 规范化 model_prefixes：去除键值首尾空白，丢弃空项；全空时返回 undefined。 */
function normalizeModelPrefixes(
  raw: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const entries = Object.entries(raw)
    .map(([pattern, prefix]) => [pattern.trim(), prefix.trim()] as const)
    .filter(([pattern, prefix]) => pattern.length > 0 && prefix.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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
        flavor: p.flavor,
        codeartsDataDir: p.codearts_data_dir,
        modelFilter: p.model_filter,
        modelPrefixes: normalizeModelPrefixes(p.model_prefixes),
        command: p.command,
        args: p.args,
        env: p.env,
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
        firstByteTimeoutMs: p.first_byte_timeout_ms,
        streamHeartbeatMs: p.stream_heartbeat_ms,
        eventDebugFrames: p.event_debug_frames,
        startupTimeoutMs: p.startup_timeout_ms,
        restartBudget: p.restart_budget,
      };
    }
    if (p.type === 'zcode') {
      return {
        ...base,
        type: 'zcode',
        command: p.command,
        args: p.args,
        env: p.env ?? {},
        workspace: p.workspace,
        workspaceRoots: p.workspace_roots,
        mode: p.mode,
        maxWorkers: p.max_workers,
        maxConcurrentSessions: p.max_concurrent_sessions,
        idleTtlMs: p.idle_ttl_ms,
        questionTimeoutMs: p.question_timeout_ms,
        taskTimeoutMs: p.task_timeout_ms,
        startupTimeoutMs: p.startup_timeout_ms,
        restartBudget: p.restart_budget,
      };
    }
    if (p.type === 'qoder') {
      return {
        ...base,
        type: 'qoder',
        command: p.command,
        args: p.args,
        env: p.env ?? {},
        workspace: p.workspace,
        workspaceRoots: p.workspace_roots,
        mode: p.mode,
        maxWorkers: p.max_workers,
        maxConcurrentSessions: p.max_concurrent_sessions,
        idleTtlMs: p.idle_ttl_ms,
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
      userAgent: p.user_agent,
      modelsUrl: p.models_url?.replace(/\/+$/, ''),
      sessionHeader: p.session_header,
      modelPrefixes: normalizeModelPrefixes(p.model_prefixes),
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
    admin: resolveAdminToken(cfg),
    storage: { path: cfg.storage.path },
    routing: {
      maxAttempts: cfg.routing.max_attempts,
      modelAliases: cfg.routing.model_aliases,
      modelBlacklist: cfg.routing.model_blacklist,
      retry: {
        enabled: cfg.routing.retry.enabled,
        maxRetries: cfg.routing.retry.max_retries,
        initialDelayMs: cfg.routing.retry.initial_delay_ms,
        maxDelayMs: cfg.routing.retry.max_delay_ms,
        jitterRatio: cfg.routing.retry.jitter_ratio,
        retryOn: [...cfg.routing.retry.retry_on],
        respectRetryAfter: cfg.routing.retry.respect_retry_after,
        maxTotalWaitMs: cfg.routing.retry.max_total_wait_ms,
      },
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
      strictCapabilities: cfg.catalog.strict_capabilities,
    },
    health: {
      enabled: cfg.health.enabled,
      intervalMs: cfg.health.interval_ms,
      timeoutMs: cfg.health.timeout_ms,
    },
    privacy: {
      mode: cfg.privacy.mode,
      identity: cfg.privacy.identity,
      protectConfigSecrets: cfg.privacy.protect_config_secrets,
      providers: {
        include: [...cfg.privacy.providers.include],
        exclude: [...cfg.privacy.providers.exclude],
      },
      tokenRetentionDays: cfg.privacy.token_retention_days,
      maxVaultEntries: cfg.privacy.max_vault_entries,
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
