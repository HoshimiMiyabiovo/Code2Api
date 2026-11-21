import type {
  CanonicalRequest,
} from '../canonical.js';
import type { OpenAIProviderConfig, ResolvedConfig } from '../config.js';
import type { ModelConfig } from '../config.js';
import { UpstreamError } from '../errors.js';
import { log } from '../logger.js';
import type { ProviderRuntime, Registry } from '../providers/registry.js';

export interface HealthSnapshot {
  status: 'healthy' | 'unhealthy' | 'unknown' | 'skipped';
  checkedAt: number;
  latencyMs?: number;
  error?: string;
  detail?: string;
}

export interface QuotaSnapshot {
  remainingPercent?: number;
  resetAt?: number;
  status?: string;
  checkedAt: number;
  latencyMs?: number;
  httpStatus?: number;
  error?: string;
}

export interface KeepaliveSnapshot {
  lastAt: number;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ProviderMonitorSnapshot {
  health: HealthSnapshot;
  quota: QuotaSnapshot | null;
  keepalive: KeepaliveSnapshot | null;
}

function getPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[key];
    }, value);
}

function firstDefined(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const found = getPath(value, path);
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
}

function normalizePercent(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const match = /-?\d+(?:\.\d+)?/.exec(value);
    if (!match) return undefined;
    return normalizePercent(Number(match[0]));
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const percent = value >= 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, percent));
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeTimestamp(numeric);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value > 1e12) return value;
  if (value > 1e9) return value * 1000;
  return Date.now() + value * 1000;
}

function normalizeStatus(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function quotaAuthHeader(provider: OpenAIProviderConfig, key: string): Record<string, string> {
  return provider.authHeader === 'bearer'
    ? { authorization: `Bearer ${key}` }
    : { 'x-api-key': key };
}

export class PoolSupervisor {
  private registry: Registry | null = null;
  private config: ResolvedConfig | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private quotaTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private readonly health = new Map<string, HealthSnapshot>();
  private readonly quota = new Map<string, QuotaSnapshot>();
  private readonly keepalive = new Map<string, KeepaliveSnapshot>();
  private readonly lastQuotaAt = new Map<string, number>();
  private readonly lastKeepaliveAt = new Map<string, number>();
  private startedAt = 0;

  start(registry: Registry, config: ResolvedConfig): void {
    this.stop();
    this.registry = registry;
    this.config = config;
    this.startedAt = Date.now();
    const healthConfig = config.health;
    if (healthConfig.enabled) {
      this.healthTimer = setInterval(() => {
        void this.probeHealthAll().catch(() => {});
      }, healthConfig.intervalMs);
      this.healthTimer.unref?.();
    }
    this.quotaTimer = setInterval(() => {
      void this.probeQuotaAll().catch(() => {});
    }, 30000);
    this.quotaTimer.unref?.();
    this.keepaliveTimer = setInterval(() => {
      void this.runKeepaliveAll().catch(() => {});
    }, 30000);
    this.keepaliveTimer.unref?.();
  }

  stop(): void {
    for (const timer of [this.healthTimer, this.quotaTimer, this.keepaliveTimer]) {
      if (timer) clearInterval(timer);
    }
    this.healthTimer = null;
    this.quotaTimer = null;
    this.keepaliveTimer = null;
    this.registry = null;
    this.config = null;
  }

  snapshot(providerId: string): ProviderMonitorSnapshot {
    return {
      health: this.health.get(providerId) ?? {
        status: 'unknown',
        checkedAt: this.startedAt,
      },
      quota: this.quota.get(providerId) ?? null,
      keepalive: this.keepalive.get(providerId) ?? null,
    };
  }

  isExhausted(providerId: string): boolean {
    const snapshot = this.quota.get(providerId);
    if (!snapshot || snapshot.remainingPercent === undefined) return false;
    if (snapshot.remainingPercent > 0) return false;
    if (snapshot.resetAt !== undefined && snapshot.resetAt <= Date.now()) return false;
    return true;
  }

  retryAfterSeconds(providerId: string): number | undefined {
    const snapshot = this.quota.get(providerId);
    if (!snapshot?.resetAt) return undefined;
    return Math.max(1, Math.ceil((snapshot.resetAt - Date.now()) / 1000));
  }

  async probeAll(): Promise<void> {
    await Promise.all([this.probeHealthAll(), this.probeQuotaAll()]);
  }

  async probeHealthAll(): Promise<void> {
    if (!this.registry || !this.config?.health.enabled) return;
    await Promise.all(
      this.registry.providers.map((provider) => this.probeHealth(provider)),
    );
  }

  private async probeHealth(provider: ProviderRuntime): Promise<void> {
    const started = performance.now();
    if (!provider.enabled) {
      this.health.set(provider.id, {
        status: 'skipped',
        checkedAt: Date.now(),
        detail: '已禁用',
      });
      return;
    }
    if (provider.type === 'mock') {
      this.health.set(provider.id, { status: 'healthy', checkedAt: Date.now(), latencyMs: 0 });
      return;
    }
    if (provider.type === 'opencode' || provider.type === 'zcode' || provider.type === 'qoder') {
      const adapter = provider.adapter as {
        workerSnapshot?: () => { state: string; lastError?: string | null };
      };
      const worker = adapter.workerSnapshot?.();
      if (!worker) {
        this.health.set(provider.id, { status: 'unknown', checkedAt: Date.now() });
        return;
      }
      if (worker.state === 'ready') {
        this.health.set(provider.id, {
          status: 'healthy',
          checkedAt: Date.now(),
          detail: 'worker ready',
        });
      } else if (worker.state === 'error' || worker.state === 'stopped') {
        this.health.set(provider.id, {
          status: 'unhealthy',
          checkedAt: Date.now(),
          error: worker.lastError ?? worker.state,
        });
      } else {
        this.health.set(provider.id, {
          status: 'unknown',
          checkedAt: Date.now(),
          detail: worker.state,
        });
      }
      return;
    }
    const config = provider.config as OpenAIProviderConfig;
    const key = provider.keys.attemptOrder()[0];
    if (!key || key.key === null) {
      this.health.set(provider.id, {
        status: 'skipped',
        checkedAt: Date.now(),
        detail: '无可用密钥',
      });
      return;
    }
    try {
      if (typeof provider.adapter.listModels !== 'function') {
        this.health.set(provider.id, {
          status: 'unknown',
          checkedAt: Date.now(),
          detail: '适配器不支持探活',
        });
        return;
      }
      const models = await provider.adapter.listModels(
        key.key,
        Math.min(this.config?.health.timeoutMs ?? 10000, config.timeouts.connectMs),
      );
      this.health.set(provider.id, {
        status: 'healthy',
        checkedAt: Date.now(),
        latencyMs: Math.round(performance.now() - started),
        detail: `${models.length} 个模型`,
      });
    } catch (error) {
      this.health.set(provider.id, {
        status: 'unhealthy',
        checkedAt: Date.now(),
        latencyMs: Math.round(performance.now() - started),
        error: (error as Error).message,
      });
    }
  }

  async probeQuotaAll(): Promise<void> {
    if (!this.registry) return;
    const now = Date.now();
    await Promise.all(
      this.registry.providers
        .filter((provider) => provider.config.type === 'openai-compatible')
        .map(async (provider) => {
          const config = provider.config as OpenAIProviderConfig;
          const quotaConfig = config.quota;
          if (!quotaConfig?.enabled) return;
          const last = this.lastQuotaAt.get(provider.id) ?? 0;
          if (now - last < quotaConfig.intervalMs) return;
          this.lastQuotaAt.set(provider.id, now);
          await this.probeQuota(provider, config, quotaConfig);
        }),
    );
  }

  private async probeQuota(
    provider: ProviderRuntime,
    providerConfig: OpenAIProviderConfig,
    quotaConfig: NonNullable<OpenAIProviderConfig['quota']>,
  ): Promise<void> {
    const started = performance.now();
    const key = provider.keys.attemptOrder()[0];
    if (!key || key.key === null) {
      this.quota.set(provider.id, {
        checkedAt: Date.now(),
        error: '无可用密钥',
      });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), quotaConfig.timeoutMs);
    try {
      const response = await fetch(quotaConfig.url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...quotaAuthHeader(providerConfig, key.key),
          ...quotaConfig.headers,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const latencyMs = Math.round(performance.now() - started);
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        const resetAt = retryAfter
          ? Date.now() + Math.max(0, Number(retryAfter) || 0) * 1000
          : undefined;
        this.quota.set(provider.id, {
          checkedAt: Date.now(),
          latencyMs,
          httpStatus: response.status,
          remainingPercent: response.status === 402 || response.status === 429 ? 0 : undefined,
          resetAt,
          error: text.slice(0, 300) || `HTTP ${response.status}`,
        });
        return;
      }
      const remainingRaw = quotaConfig.remainingPath
        ? getPath(json, quotaConfig.remainingPath)
        : firstDefined(json, [
            'remaining_percent',
            'remainingPercent',
            'data.remaining_percent',
            'data.remainingPercent',
            'data.remaining',
            'remaining',
            'balance',
          ]);
      const resetRaw = quotaConfig.resetAtPath
        ? getPath(json, quotaConfig.resetAtPath)
        : firstDefined(json, [
            'reset_at',
            'resetAt',
            'resets_at',
            'data.reset_at',
            'data.resetAt',
            'data.resets_at',
          ]);
      const statusRaw = quotaConfig.statusPath
        ? getPath(json, quotaConfig.statusPath)
        : firstDefined(json, ['status', 'data.status']);
      const remainingPercent = normalizePercent(remainingRaw);
      const resetAt = normalizeTimestamp(resetRaw);
      this.quota.set(provider.id, {
        checkedAt: Date.now(),
        latencyMs,
        httpStatus: response.status,
        remainingPercent,
        resetAt:
          remainingPercent === 0 && resetAt === undefined
            ? Date.now() + quotaConfig.intervalMs
            : resetAt,
        status: normalizeStatus(statusRaw),
      });
    } catch (error) {
      this.quota.set(provider.id, {
        checkedAt: Date.now(),
        latencyMs: Math.round(performance.now() - started),
        error: (error as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async runKeepaliveAll(force = false): Promise<void> {
    if (!this.registry) return;
    const now = Date.now();
    await Promise.all(
      this.registry.providers.map(async (provider) => {
        if (provider.config.type !== 'openai-compatible') return;
        const config = provider.config as OpenAIProviderConfig;
        const keepaliveConfig = config.keepalive;
        if (!keepaliveConfig?.enabled) return;
        const last = this.lastKeepaliveAt.get(provider.id) ?? 0;
        if (!force && now - last < keepaliveConfig.intervalMs) return;
        if (this.isExhausted(provider.id)) return;
        this.lastKeepaliveAt.set(provider.id, now);
        await this.runKeepalive(provider, config, keepaliveConfig);
      }),
    );
  }

  private async runKeepalive(
    provider: ProviderRuntime,
    providerConfig: OpenAIProviderConfig,
    keepaliveConfig: NonNullable<OpenAIProviderConfig['keepalive']>,
  ): Promise<void> {
    const key = provider.keys.attemptOrder()[0];
    if (!key || key.key === null) return;
    const model =
      provider.models.find(
        (item) => item.id === keepaliveConfig.model || item.upstream === keepaliveConfig.model,
      ) ?? provider.models[0];
    if (!model) return;
    const started = performance.now();
    provider.keys.markAttempt(key);
    const request: CanonicalRequest = {
      model: model.id,
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: keepaliveConfig.prompt }],
        },
      ],
      stream: false,
      maxTokens: keepaliveConfig.maxTokens,
    };
    try {
      await provider.adapter.chat(request, model, {
        key: key.key,
        signal: AbortSignal.timeout(Math.min(providerConfig.timeouts.ttfbMs, 60000)),
      });
      provider.keys.markSuccess(key);
      this.keepalive.set(provider.id, {
        lastAt: Date.now(),
        ok: true,
        latencyMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      const upErr =
        error instanceof UpstreamError
          ? error
          : new UpstreamError((error as Error).message, { category: 'server' });
      provider.keys.markFailure(
        key,
        upErr.category,
        this.config?.routing.cooldowns ?? {
          authMs: 600000,
          rateLimitMs: 60000,
          paymentMs: 1800000,
          serverMs: 15000,
          networkMs: 10000,
          emptyStreamMs: 5000,
          maxMs: 1800000,
        },
        upErr.retryAfterMs,
      );
      this.keepalive.set(provider.id, {
        lastAt: Date.now(),
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: upErr.message,
      });
      log.warn(`保活失败 ${provider.id}: ${upErr.message}`);
    }
  }
}
