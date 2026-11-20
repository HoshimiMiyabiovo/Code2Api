import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';import {
  parseConfig,
  type KeyConfig,
  type ModelConfig,
  type ModelPricing,
  type ProviderConfig,
  type ResolvedConfig,
  type Timeouts,
} from '../config.js';
import { GatewayError } from '../errors.js';

const DEFAULT_TIMEOUTS: Timeouts = {
  connectMs: 30000,
  ttfbMs: 60000,
  idleMs: 120000,
  totalMs: 600000,
};

const envNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '环境变量名不合法');

const keyLabelSchema = z.string().trim().min(1, '密钥 label 不能为空').max(64);

const modelInputSchema = z.object({
  id: z.string().trim().min(1, '模型 id 不能为空').max(128),
  upstream: z.string().trim().min(1).max(128).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: z
    .object({
      tools: z.boolean().default(true),
      vision: z.boolean().default(false),
      reasoning: z.boolean().default(false),
    })
    .default({}),
  pricing: z
    .object({
      inputPerMtok: z.number().nonnegative().optional(),
      outputPerMtok: z.number().nonnegative().optional(),
      cacheReadPerMtok: z.number().nonnegative().optional(),
      cacheWritePerMtok: z.number().nonnegative().optional(),
    })
    .optional(),
  reasoningEffort: z.string().trim().min(1).max(32).optional(),
  source: z.enum(['config', 'upstream']).optional(),
});

const keyInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep'), label: keyLabelSchema }),
  z.object({ action: z.literal('remove'), label: keyLabelSchema }),
  z.object({ action: z.literal('set_env'), label: keyLabelSchema, keyEnv: envNameSchema }),
  z.object({
    action: z.literal('set_key'),
    label: keyLabelSchema,
    key: z.string().trim().min(1, '密钥不能为空').max(4096),
  }),
  z.object({
    action: z.literal('new'),
    label: keyLabelSchema,
    mode: z.enum(['env', 'key']),
    keyEnv: envNameSchema.optional(),
    key: z.string().trim().min(1).max(4096).optional(),
  }),
]);

const channelInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, '渠道 id 仅支持字母、数字、. _ -'),
  type: z.enum(['openai-compatible', 'mock', 'opencode']),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
  baseUrl: z.string().trim().url('base_url 必须是完整 URL').max(2048).optional(),
  authHeader: z.enum(['bearer', 'x-api-key']).default('bearer'),
  tokenLimitField: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  sendStreamOptions: z.boolean().default(true),
  syncModels: z.boolean().default(true),
  defaultReasoningEffort: z.string().trim().min(1).max(32).optional(),
  reasoningBudgetField: z.string().trim().min(1).max(128).optional(),
  command: z.string().trim().min(1).max(1024).optional(),
  workspace: z.string().trim().min(1).max(1024).optional(),
  workspaceRoots: z.array(z.string().trim().min(1).max(1024)).max(32).optional(),
  agent: z.string().trim().min(1).max(128).optional(),
  permissionMode: z.enum(['ask', 'allow', 'deny']).default('ask'),
  autoModels: z.boolean().default(true),
  maxWorkers: z.number().int().min(1).max(8).optional(),
  maxConcurrentSessions: z.number().int().min(1).max(64).optional(),
  idleTtlMs: z.number().int().positive().optional(),
  memoryBudgetMb: z.number().int().min(0).optional(),
  keys: z.array(keyInputSchema).default([]),
  models: z.array(modelInputSchema).default([]),
});

export type ChannelInput = z.infer<typeof channelInputSchema>;
type KeyInput = z.infer<typeof keyInputSchema>;
type ModelInput = z.infer<typeof modelInputSchema>;

export interface SaveChannelResult {
  config: ResolvedConfig;
  warnings: string[];
}

type YamlDocument = ReturnType<typeof YAML.parseDocument>;

function bad(message: string, status = 400, type = 'invalid_request_error'): never {
  throw new GatewayError(message, { status, type, code: 'config_invalid' });
}

export function parseChannelInput(raw: unknown): ChannelInput {
  const result = channelInputSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('；');
    bad(`渠道配置校验失败：${details}`);
  }
  return result.data;
}

function modelToConfig(model: ModelInput): ModelConfig {
  const pricing = model.pricing;
  const hasPricing =
    pricing &&
    (pricing.inputPerMtok !== undefined ||
      pricing.outputPerMtok !== undefined ||
      pricing.cacheReadPerMtok !== undefined ||
      pricing.cacheWritePerMtok !== undefined);
  return {
    id: model.id,
    upstream: model.upstream ?? model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: {
      tools: model.capabilities.tools,
      vision: model.capabilities.vision,
      reasoning: model.capabilities.reasoning,
    },
    pricing: hasPricing ? pricing : undefined,
    reasoningEffort: model.reasoningEffort,
    source: 'config',
  };
}

function resolveEnvKey(label: string, keyEnv: string): KeyConfig {
  const value = process.env[keyEnv];
  return {
    label,
    key: value ?? null,
    keyEnv,
    missingEnv: value ? undefined : keyEnv,
  };
}

function mergeKeys(
  existing: KeyConfig[],
  specs: KeyInput[],
  creating: boolean,
): KeyConfig[] {
  const existingByLabel = new Map(existing.map((key) => [key.label, key]));
  const usedLabels = new Set<string>();
  const result: KeyConfig[] = [];

  for (const spec of specs) {
    if (usedLabels.has(spec.label)) {
      bad(`密钥 label 重复：${spec.label}`);
    }
    usedLabels.add(spec.label);
    const current = existingByLabel.get(spec.label);
    switch (spec.action) {
      case 'keep':
        if (!current) bad(`密钥 ${spec.label} 不存在，无法保留`);
        result.push({ ...current });
        break;
      case 'remove':
        if (!current) bad(`密钥 ${spec.label} 不存在，无法删除`);
        break;
      case 'set_env':
        if (!current) bad(`密钥 ${spec.label} 不存在，无法修改`);
        result.push(resolveEnvKey(spec.label, spec.keyEnv));
        break;
      case 'set_key':
        if (!current) bad(`密钥 ${spec.label} 不存在，无法修改`);
        result.push({ label: spec.label, key: spec.key });
        break;
      case 'new':
        if (creating === false && current) {
          bad(`密钥 ${spec.label} 已存在，请使用修改操作`);
        }
        if (spec.mode === 'env') {
          if (!spec.keyEnv) bad(`新密钥 ${spec.label} 缺少环境变量名`);
          result.push(resolveEnvKey(spec.label, spec.keyEnv));
        } else {
          if (!spec.key) bad(`新密钥 ${spec.label} 缺少密钥值`);
          result.push({ label: spec.label, key: spec.key });
        }
        break;
    }
  }

  for (const label of existingByLabel.keys()) {
    if (!usedLabels.has(label)) {
      bad(`缺少现有密钥 ${label} 的处理方式（保留 / 更换 / 删除）`);
    }
  }
  return result;
}

function buildProvider(input: ChannelInput, existing?: ProviderConfig): ProviderConfig {
  if (existing && existing.type !== input.type) {
    bad('不支持修改渠道类型');
  }
  if (input.type === 'mock' && input.keys.length > 0) {
    bad('mock 渠道不需要密钥');
  }
  const modelIds = new Set<string>();
  const models = input.models.map((model) => {
    if (modelIds.has(model.id)) bad(`模型 id 重复：${model.id}`);
    modelIds.add(model.id);
    return modelToConfig(model);
  });
  if (models.length === 0 && !(input.type === 'opencode' && input.autoModels)) {
    bad('至少配置一个模型（opencode 可开启自动发现）');
  }
  const base = {
    id: input.id,
    priority: input.priority,
    enabled: input.enabled,
    models,
  };
  if (input.type === 'mock') {
    if (input.keys.length > 0) bad('mock 渠道不需要密钥');
    return { ...base, type: 'mock' };
  }
  if (input.type === 'opencode') {
    if (input.keys.length > 0) bad('opencode 渠道不需要密钥');
    for (const model of models) {
      if (!model.upstream.includes('/')) {
        bad(`opencode 模型 ${model.id} 的 upstream 必须是 providerID/modelID`);
      }
    }
    const existingOc = existing?.type === 'opencode' ? existing : null;
    return {
      ...base,
      type: 'opencode',
      command: input.command ?? existingOc?.command ?? 'opencode',
      args: existingOc?.args ?? [],
      workspace: input.workspace ?? existingOc?.workspace ?? './workspace',
      workspaceRoots: input.workspaceRoots ?? existingOc?.workspaceRoots ?? [],
      hostname: existingOc?.hostname ?? '127.0.0.1',
      port: existingOc?.port,
      baseUrl: input.baseUrl
        ? input.baseUrl.replace(/\/+$/, '')
        : existingOc?.baseUrl,
      username: existingOc?.username ?? 'opencode',
      passwordEnv: existingOc?.passwordEnv ?? 'OPENCODE_SERVER_PASSWORD',
      agent: input.agent ?? existingOc?.agent ?? 'build',
      permissionMode: input.permissionMode ?? existingOc?.permissionMode ?? 'ask',
      autoModels: input.autoModels ?? existingOc?.autoModels ?? true,
      maxWorkers: input.maxWorkers ?? existingOc?.maxWorkers ?? 1,
      maxConcurrentSessions:
        input.maxConcurrentSessions ?? existingOc?.maxConcurrentSessions ?? 4,
      idleTtlMs: input.idleTtlMs ?? existingOc?.idleTtlMs ?? 900000,
      memoryBudgetMb: input.memoryBudgetMb ?? existingOc?.memoryBudgetMb ?? 0,
      questionTimeoutMs: existingOc?.questionTimeoutMs ?? 600000,
      taskTimeoutMs: existingOc?.taskTimeoutMs ?? 1800000,
      startupTimeoutMs: existingOc?.startupTimeoutMs ?? 60000,
      restartBudget: existingOc?.restartBudget ?? 3,
    };
  }
  if (!input.baseUrl) bad('openai-compatible 渠道需要填写 base_url');
  const keys = mergeKeys(
    existing?.type === 'openai-compatible' ? existing.keys : [],
    input.keys,
    !existing,
  );
  return {
    ...base,
    type: 'openai-compatible',
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    authHeader: input.authHeader,
    tokenLimitField: input.tokenLimitField,
    sendStreamOptions: input.sendStreamOptions,
    extraHeaders: existing?.type === 'openai-compatible' ? existing.extraHeaders : {},
    timeouts: existing?.type === 'openai-compatible' ? existing.timeouts : DEFAULT_TIMEOUTS,
    syncModels: existing?.type === 'openai-compatible' ? existing.syncModels : true,
    defaultReasoningEffort:
      existing?.type === 'openai-compatible' ? existing.defaultReasoningEffort : undefined,
    reasoningBudgetField:
      existing?.type === 'openai-compatible' ? existing.reasoningBudgetField : undefined,
    quota: existing?.type === 'openai-compatible' ? existing.quota : undefined,
    keepalive: existing?.type === 'openai-compatible' ? existing.keepalive : undefined,
    keys,
  };
}

function pricingToRaw(pricing: ModelPricing | undefined): Record<string, number> | undefined {
  if (!pricing) return undefined;
  const raw: Record<string, number> = {};
  if (pricing.inputPerMtok !== undefined) raw.input_per_mtok = pricing.inputPerMtok;
  if (pricing.outputPerMtok !== undefined) raw.output_per_mtok = pricing.outputPerMtok;
  if (pricing.cacheReadPerMtok !== undefined) raw.cache_read_per_mtok = pricing.cacheReadPerMtok;
  if (pricing.cacheWritePerMtok !== undefined) {
    raw.cache_write_per_mtok = pricing.cacheWritePerMtok;
  }
  return Object.keys(raw).length > 0 ? raw : undefined;
}

function modelsToRaw(models: ModelConfig[]): Record<string, unknown>[] {
  return models.map((model) => {
    const raw: Record<string, unknown> = { id: model.id };
    if (model.upstream && model.upstream !== model.id) raw.upstream = model.upstream;
    if (model.contextWindow !== undefined) raw.context_window = model.contextWindow;
    if (model.maxOutputTokens !== undefined) raw.max_output_tokens = model.maxOutputTokens;
    raw.capabilities = {
      tools: model.capabilities.tools,
      vision: model.capabilities.vision,
      reasoning: model.capabilities.reasoning,
    };
    const pricing = pricingToRaw(model.pricing);
    if (pricing) raw.pricing = pricing;
    if (model.reasoningEffort) raw.reasoning_effort = model.reasoningEffort;
    return raw;
  });
}

function providerToRaw(provider: ProviderConfig): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: provider.id,
    type: provider.type,
    priority: provider.priority,
    enabled: provider.enabled,
  };
  if (provider.type === 'openai-compatible') {
    raw.base_url = provider.baseUrl;
    raw.auth_header = provider.authHeader;
    raw.token_limit_field = provider.tokenLimitField;
    raw.send_stream_options = provider.sendStreamOptions;
    raw.sync_models = provider.syncModels;
    if (provider.defaultReasoningEffort) {
      raw.default_reasoning_effort = provider.defaultReasoningEffort;
    }
    if (provider.reasoningBudgetField) {
      raw.reasoning_budget_field = provider.reasoningBudgetField;
    }
    if (provider.quota) {
      raw.quota = {
        enabled: provider.quota.enabled,
        url: provider.quota.url,
        interval_ms: provider.quota.intervalMs,
        timeout_ms: provider.quota.timeoutMs,
        ...(Object.keys(provider.quota.headers).length > 0
          ? { headers: provider.quota.headers }
          : {}),
        ...(provider.quota.remainingPath
          ? { remaining_path: provider.quota.remainingPath }
          : {}),
        ...(provider.quota.resetAtPath
          ? { reset_at_path: provider.quota.resetAtPath }
          : {}),
        ...(provider.quota.statusPath
          ? { status_path: provider.quota.statusPath }
          : {}),
      };
    }
    if (provider.keepalive) {
      raw.keepalive = {
        enabled: provider.keepalive.enabled,
        interval_ms: provider.keepalive.intervalMs,
        ...(provider.keepalive.model ? { model: provider.keepalive.model } : {}),
        max_tokens: provider.keepalive.maxTokens,
        prompt: provider.keepalive.prompt,
      };
    }
    if (Object.keys(provider.extraHeaders).length > 0) {
      raw.extra_headers = provider.extraHeaders;
    }
    raw.timeouts = {
      connect_ms: provider.timeouts.connectMs,
      ttfb_ms: provider.timeouts.ttfbMs,
      idle_ms: provider.timeouts.idleMs,
      total_ms: provider.timeouts.totalMs,
    };
    raw.keys = provider.keys.map((key) => {
      if (key.keyEnv) return { label: key.label, key_env: key.keyEnv };
      if (key.key) return { label: key.label, key: key.key };
      throw new Error(`渠道 ${provider.id} 密钥 ${key.label} 既无 key 也无 key_env`);
    });
  } else if (provider.type === 'opencode') {
    raw.command = provider.command;
    if (provider.args.length > 0) raw.args = provider.args;
    raw.workspace = provider.workspace;
    if (provider.workspaceRoots.length > 0) raw.workspace_roots = provider.workspaceRoots;
    raw.hostname = provider.hostname;
    if (provider.port !== undefined) raw.port = provider.port;
    if (provider.baseUrl) raw.base_url = provider.baseUrl;
    raw.username = provider.username;
    raw.password_env = provider.passwordEnv;
    raw.agent = provider.agent;
    raw.permission_mode = provider.permissionMode;
    raw.auto_models = provider.autoModels;
    raw.max_workers = provider.maxWorkers;
    raw.max_concurrent_sessions = provider.maxConcurrentSessions;
    raw.idle_ttl_ms = provider.idleTtlMs;
    raw.memory_budget_mb = provider.memoryBudgetMb;
    raw.question_timeout_ms = provider.questionTimeoutMs;
    raw.task_timeout_ms = provider.taskTimeoutMs;
    raw.startup_timeout_ms = provider.startupTimeoutMs;
    raw.restart_budget = provider.restartBudget;
  }
  raw.models = modelsToRaw(provider.models);
  return raw;
}

function collectWarnings(config: ResolvedConfig): string[] {
  const warnings: string[] = [];
  for (const provider of config.providers) {
    if (provider.type !== 'openai-compatible') continue;
    for (const key of provider.keys) {
      if (key.missingEnv) {
        warnings.push(
          `渠道 ${provider.id} 密钥 ${key.label} 缺少环境变量 ${key.missingEnv}，暂时不可用`,
        );
      }
    }
  }
  return warnings;
}

function readConfigDocument(configPath: string): {
  doc: YamlDocument;
  config: ResolvedConfig;
} {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    bad(`无法读取配置文件：${(error as Error).message}`, 500, 'config_read_error');
  }
  let doc: YamlDocument;
  try {
    doc = YAML.parseDocument(text);
  } catch (error) {
    bad(`配置文件 YAML 解析失败：${(error as Error).message}`, 500, 'config_read_error');
  }
  if (doc.errors.length > 0) {
    bad(`配置文件 YAML 解析失败：${doc.errors[0]?.message ?? '未知错误'}`, 500, 'config_read_error');
  }
  let config: ResolvedConfig;
  try {
    config = parseConfig(doc.toJS());
  } catch (error) {
    bad((error as Error).message, 500, 'config_invalid');
  }
  return { doc, config };
}

function persistProviders(
  configPath: string,
  doc: YamlDocument,
  providers: ProviderConfig[],
): ResolvedConfig {
  const rawProviders = providers.map(providerToRaw);
  const baseRaw = doc.toJS() as Record<string, unknown>;
  try {
    parseConfig({ ...baseRaw, providers: rawProviders });
  } catch (error) {
    bad((error as Error).message, 400, 'config_invalid');
  }

  doc.set('providers', rawProviders);
  const output = doc.toString({ lineWidth: 0 });
  let finalConfig: ResolvedConfig;
  try {
    finalConfig = parseConfig(YAML.parse(output));
  } catch (error) {
    bad(`配置序列化后校验失败：${(error as Error).message}`, 500, 'config_invalid');
  }

  try {
    copyFileSync(configPath, `${configPath}.bak`);
  } catch (error) {
    bad(`无法备份配置文件：${(error as Error).message}`, 500, 'config_write_error');
  }
  const tempPath = `${configPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, output, 'utf8');
    renameSync(tempPath, configPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    bad(`写入配置文件失败：${(error as Error).message}`, 500, 'config_write_error');
  }
  return finalConfig;
}

let writeQueue: Promise<unknown> = Promise.resolve();

function exclusive<T>(task: () => T): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function upsertChannel(
  configPath: string,
  input: ChannelInput,
  mode: 'create' | 'update',
): Promise<SaveChannelResult> {
  return exclusive(() => {
    const { doc, config } = readConfigDocument(configPath);
    const existing = config.providers.find((provider) => provider.id === input.id);
    if (mode === 'create' && existing) {
      bad(`渠道 ${input.id} 已存在`, 409, 'conflict');
    }
    if (mode === 'update' && !existing) {
      bad(`渠道 ${input.id} 不存在`, 404, 'not_found');
    }
    const provider = buildProvider(input, existing);
    const providers =
      mode === 'create'
        ? [...config.providers, provider]
        : config.providers.map((item) => (item.id === input.id ? provider : item));
    const nextConfig = persistProviders(configPath, doc, providers);
    return { config: nextConfig, warnings: collectWarnings(nextConfig) };
  });
}

export function deleteChannel(configPath: string, id: string): Promise<SaveChannelResult> {
  return exclusive(() => {
    const { doc, config } = readConfigDocument(configPath);
    if (!config.providers.some((provider) => provider.id === id)) {
      bad(`渠道 ${id} 不存在`, 404, 'not_found');
    }
    if (config.providers.length <= 1) {
      bad('至少保留一个渠道');
    }
    const providers = config.providers.filter((provider) => provider.id !== id);
    const nextConfig = persistProviders(configPath, doc, providers);
    return { config: nextConfig, warnings: collectWarnings(nextConfig) };
  });
}
