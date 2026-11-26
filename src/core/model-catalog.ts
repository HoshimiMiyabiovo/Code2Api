import type { CatalogConfig, ModelConfig } from '../config.js';
import { log } from '../logger.js';
import type { Registry } from '../providers/registry.js';
import { matchesGlob } from './model-rules.js';

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

/**
 * 匹配渠道 model_prefixes 规则（glob → 前缀），决定自动发现模型的对外名前缀。
 * 与 model_filter 同语义：模式同时匹配裸 modelID 与 providerID/modelID（upstream），
 * 命中多条时取先配置的；返回 undefined 表示不加前缀。
 */
export function matchModelPrefix(
  prefixes: Record<string, string> | undefined,
  modelId: string,
  upstream?: string,
): string | undefined {
  if (!prefixes) return undefined;
  for (const [pattern, prefix] of Object.entries(prefixes)) {
    if (matchesGlob(modelId, pattern) || (upstream !== undefined && matchesGlob(upstream, pattern))) {
      return prefix;
    }
  }
  return undefined;
}

/** 给探测/同步类调用加总超时；导出供 admin 探测端点复用。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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
              // 渠道 model_prefixes：按 upstream 给对外名加前缀（如 opencode-go/* → Go/）。
              const prefix = matchModelPrefix(providerConfig.modelPrefixes, info.id, info.upstream);
              const syncedId = prefix ? `${prefix}${info.id}` : info.id;
              const conflict = registry
                .candidates(syncedId)
                .some((entry) => entry.provider.id !== provider.id);
              const model: ModelConfig = {
                ...info,
                id: conflict ? `${provider.id}/${syncedId}` : syncedId,
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
            const detected = info.capabilities ?? {};
            let reasoning = detected.reasoning;
            if (reasoning === undefined) {
              // 上游未声明时：默认放行（由上游报错后自动降级）；
              // strict_capabilities=true 时恢复严格（按名字推断或判为不支持）。
              reasoning = config.strictCapabilities
                ? config.reasoningHints && guessReasoningModel(info.id)
                : true;
            }
            const prefix = matchModelPrefix(providerConfig.modelPrefixes, info.id, info.id);
            const model: ModelConfig = {
              id: prefix ? `${prefix}${info.id}` : info.id,
              upstream: info.id,
              contextWindow: info.contextWindow,
              maxOutputTokens: info.maxOutputTokens,
              capabilities: {
                tools: detected.tools ?? true,
                vision: detected.vision ?? false,
                reasoning,
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
