import type { CatalogConfig, ModelConfig } from '../config.js';
import { log } from '../logger.js';
import type { Registry } from '../providers/registry.js';

export interface CatalogSyncReport {
  providerId: string;
  ok: boolean;
  skipped?: boolean;
  added: number;
  /** 已存在但被回填上下文窗口的数量。 */
  updated?: number;
  total: number;
  error?: string;
}

export interface CatalogSyncResult {
  syncedAt: number;
  added: number;
  reports: CatalogSyncReport[];
}

/** 按模型名推断是否为推理模型；可被手工配置覆盖。 */
const REASONING_NAME_PATTERNS: RegExp[] = [
  /reasoner/i,
  /thinking/i,
  /\br1\b/,
  /\bo1\b/,
  /\bo3\b/,
  /\bo4\b/,
  /deepseek-r/i,
  /qwq/i,
  /kimi-k/i,
  /glm-4\.5/i,
  /gpt-5/i,
  /claude/i,
  /gemini-?2\.5/i,
  /grok-?3/i,
];

export function guessReasoningModel(id: string): boolean {
  return REASONING_NAME_PATTERNS.some((pattern) => pattern.test(id));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 模型目录同步器：从各 OpenAI 兼容渠道的 /models 拉取模型列表，
 * 合并进注册表；手工配置的模型优先，不会被覆盖。
 */
export class ModelCatalog {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastResult: CatalogSyncResult | null = null;

  lastSyncAt(): number | null {
    return this.lastResult?.syncedAt ?? null;
  }

  lastError(): string | null {
    const failed = this.lastResult?.reports.find((report) => !report.ok);
    return failed?.error ?? null;
  }

  snapshot(): {
    lastSyncAt: number | null;
    lastError: string | null;
    lastAdded: number;
    reports: CatalogSyncReport[];
  } {
    return {
      lastSyncAt: this.lastResult?.syncedAt ?? null,
      lastError: this.lastError(),
      lastAdded: this.lastResult?.added ?? 0,
      reports: this.lastResult?.reports ?? [],
    };
  }

  async sync(registry: Registry, config: CatalogConfig): Promise<CatalogSyncResult> {
    const syncedAt = Date.now();
    if (!config.syncEnabled) {
      return { syncedAt, added: 0, reports: [] };
    }
    if (this.running) {
      return this.lastResult ?? { syncedAt, added: 0, reports: [] };
    }
    this.running = true;
    try {
      const reports: CatalogSyncReport[] = [];
      let added = 0;
      for (const provider of registry.providers) {
        const providerConfig = provider.config;
        if (!provider.enabled) continue;
        if (providerConfig.type === 'opencode') {
          if (!providerConfig.autoModels) {
            reports.push({
              providerId: provider.id,
              ok: true,
              skipped: true,
              added: 0,
              total: 0,
            });
            continue;
          }
          const adapter = provider.adapter as {
            listModelInfos?: () => Promise<ModelConfig[]>;
          };
          if (typeof adapter.listModelInfos !== 'function') continue;
          try {
            const infos = await withTimeout(
              adapter.listModelInfos(),
              Math.min(providerConfig.startupTimeoutMs, 15000),
              `opencode ${provider.id} 模型探测`,
            );
            let providerAdded = 0;
            for (const info of infos) {
              const conflict = registry
                .candidates(info.id)
                .some((entry) => entry.provider.id !== provider.id);
              const model: ModelConfig = {
                ...info,
                id: conflict ? `${provider.id}/${info.id}` : info.id,
                source: 'upstream',
              };
              if (registry.addUpstreamModel(provider.id, model).added) providerAdded += 1;
            }
            added += providerAdded;
            reports.push({
              providerId: provider.id,
              ok: true,
              added: providerAdded,
              total: infos.length,
            });
            if (providerAdded > 0) {
              log.info(
                `opencode 模型探测 ${provider.id}：新增 ${providerAdded}/${infos.length} 个模型`,
              );
            }
          } catch (error) {
            const message = (error as Error).message;
            reports.push({
              providerId: provider.id,
              ok: false,
              added: 0,
              total: 0,
              error: message,
            });
            log.warn(`opencode 模型探测 ${provider.id} 失败: ${message}`);
          }
          continue;
        }
        if (providerConfig.type !== 'openai-compatible') continue;
        if (!providerConfig.syncModels) continue;
        if (typeof provider.adapter.listModels !== 'function') continue;

        const key = provider.keys.attemptOrder()[0];
        if (!key || key.key === null) {
          reports.push({
            providerId: provider.id,
            ok: true,
            skipped: true,
            added: 0,
            total: 0,
          });
          continue;
        }

        try {
          // 同步使用较短的独立超时，避免上游不可达拖慢启动。
          const infos = await provider.adapter.listModels(
            key.key,
            Math.min(providerConfig.timeouts.connectMs, 15000),
          );
          let providerAdded = 0;
          let providerUpdated = 0;
          for (const info of infos) {
            const model: ModelConfig = {
              id: info.id,
              upstream: info.id,
              contextWindow: info.contextWindow,
              capabilities: {
                tools: true,
                vision: false,
                reasoning: config.reasoningHints ? guessReasoningModel(info.id) : false,
              },
              source: 'upstream',
            };
            const result = registry.addUpstreamModel(provider.id, model);
            if (result.added) providerAdded += 1;
            if (result.updated) providerUpdated += 1;
          }
          added += providerAdded;
          reports.push({
            providerId: provider.id,
            ok: true,
            added: providerAdded,
            updated: providerUpdated,
            total: infos.length,
          });
          if (providerAdded > 0 || providerUpdated > 0) {
            log.info(
              `模型目录同步 ${provider.id}：新增 ${providerAdded}/${infos.length}，回填上下文 ${providerUpdated} 个`,
            );
          }
        } catch (error) {
          const message = (error as Error).message;
          reports.push({
            providerId: provider.id,
            ok: false,
            added: 0,
            total: 0,
            error: message,
          });
          log.warn(`模型目录同步 ${provider.id} 失败: ${message}`);
        }
      }
      this.lastResult = { syncedAt, added, reports };
      return this.lastResult;
    } finally {
      this.running = false;
    }
  }

  start(registry: Registry, config: CatalogConfig): void {
    if (!config.syncEnabled) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sync(registry, config).catch((error) => {
        log.warn(`模型目录定时同步失败: ${(error as Error).message}`);
      });
    }, config.syncIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
