import type { ModelCapabilities, ModelConfig, ModelPricing, ProviderConfig, ResolvedConfig } from '../config.js';
import { KeyPool } from '../core/keys.js';
import { log } from '../logger.js';
import type { Store } from '../store/db.js';
import { MockAdapter } from './mock.js';
import { OpenCodeAdapter } from './opencode.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { QoderAdapter } from './qoder.js';
import { ZcodeAdapter } from './zcode.js';
import type { ProviderAdapter } from './types.js';

export interface ProviderRuntime {
  id: string;
  type: ProviderConfig['type'];
  priority: number;
  enabled: boolean;
  config: ProviderConfig;
  adapter: ProviderAdapter;
  keys: KeyPool;
  models: ModelConfig[];
  disabledReason?: string;
}

export interface ModelEntry {
  provider: ProviderRuntime;
  model: ModelConfig;
}

export interface ModelListing {
  id: string;
  providers: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
}

/** 按渠道配置构造适配器；探测端点用临时适配器探测草稿配置，用完即 close。 */
export function createAdapter(config: ProviderConfig, store: Store | undefined): ProviderAdapter {
  switch (config.type) {
    case 'mock':
      return new MockAdapter();
    case 'openai-compatible':
      return new OpenAICompatibleAdapter(config);
    case 'opencode':
      if (!store) {
        throw new Error('opencode 渠道需要 Store 支持');
      }
      return new OpenCodeAdapter(config, store);
    case 'zcode':
      if (!store) {
        throw new Error('zcode 渠道需要 Store 支持');
      }
      return new ZcodeAdapter(config, store);
    case 'qoder':
      if (!store) {
        throw new Error('qoder 渠道需要 Store 支持');
      }
      return new QoderAdapter(config, store);
  }
}

export class Registry {
  readonly providers: ProviderRuntime[] = [];
  private readonly modelIndex = new Map<string, ModelEntry[]>();

  constructor(config: ResolvedConfig, store?: Store) {
    for (const providerConfig of config.providers) {
      const keys = new KeyPool(
        providerConfig.type === 'openai-compatible' ? providerConfig.keys : [],
      );
      let disabledReason: string | undefined;
      if (!providerConfig.enabled) {
        disabledReason = 'disabled';
      } else if (
        providerConfig.type === 'openai-compatible' &&
        providerConfig.keys.length > 0 &&
        !keys.hasUsableKey()
      ) {
        disabledReason = '所有密钥缺少环境变量';
      }

      const seen = new Set<string>();
      const models: ModelConfig[] = [];
      for (const model of providerConfig.models) {
        if (seen.has(model.id)) {
          log.warn(`渠道 ${providerConfig.id} 模型 ${model.id} 重复，已忽略后者`);
          continue;
        }
        seen.add(model.id);
        models.push(model);
      }

      this.providers.push({
        id: providerConfig.id,
        type: providerConfig.type,
        priority: providerConfig.priority,
        enabled: providerConfig.enabled,
        config: providerConfig,
        adapter: createAdapter(providerConfig, store),
        keys,
        models,
        disabledReason,
      });
    }

    const sorted = [...this.providers].sort((a, b) => a.priority - b.priority);
    for (const provider of sorted) {
      for (const model of provider.models) {
        const entries = this.modelIndex.get(model.id) ?? [];
        entries.push({ provider, model });
        this.modelIndex.set(model.id, entries);
      }
    }
  }

  candidates(modelId: string): ModelEntry[] {
    return this.modelIndex.get(modelId) ?? [];
  }

  modelEntries(): ModelEntry[] {
    return [...this.modelIndex.values()].flat();
  }

  /**
   * 将上游目录同步到的模型并入指定渠道。
   * 已存在时保留手工配置：手工填写的上下文窗口/最大输出始终优先；
   * 留空的字段自动采用上游目录声明值，同一运行周期内多次同步取最大值。
   */
  addUpstreamModel(
    providerId: string,
    model: ModelConfig,
  ): { added: boolean; updated: boolean } {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) return { added: false, updated: false };
    const existing = provider.models.find(
      (item) => item.id === model.id || item.upstream === model.upstream,
    );
    if (existing) {
      let updated = false;
      // 手工填写的值是明确的用户意图，始终优先；留空则自动采用目录声明值。
      const pinnedWindow = existing.source === 'config' ? existing.contextWindow : undefined;
      if (
        model.contextWindow &&
        !pinnedWindow &&
        model.contextWindow > (existing.contextWindow ?? 0)
      ) {
        existing.contextWindow = model.contextWindow;
        updated = true;
      }
      const pinnedOutput = existing.source === 'config' ? existing.maxOutputTokens : undefined;
      if (
        model.maxOutputTokens &&
        !pinnedOutput &&
        model.maxOutputTokens > (existing.maxOutputTokens ?? 0)
      ) {
        existing.maxOutputTokens = model.maxOutputTokens;
        updated = true;
      }
      return { added: false, updated };
    }
    provider.models.push(model);
    const entries = this.modelIndex.get(model.id) ?? [];
    entries.push({ provider, model });
    this.modelIndex.set(model.id, entries);
    return { added: true, updated: false };
  }

  listModels(): ModelListing[] {
    const listings = new Map<string, ModelListing>();
    for (const entry of this.modelEntries()) {
      const existing = listings.get(entry.model.id);
      if (!existing) {
        listings.set(entry.model.id, {
          id: entry.model.id,
          providers: [entry.provider.id],
          contextWindow: entry.model.contextWindow,
          maxOutputTokens: entry.model.maxOutputTokens,
          capabilities: entry.model.capabilities,
          pricing: entry.model.pricing,
        });
      } else {
        existing.providers.push(entry.provider.id);
        existing.capabilities = {
          tools: existing.capabilities.tools || entry.model.capabilities.tools,
          vision: existing.capabilities.vision || entry.model.capabilities.vision,
          reasoning: existing.capabilities.reasoning || entry.model.capabilities.reasoning,
        };
        if (entry.model.contextWindow && existing.contextWindow) {
          existing.contextWindow = Math.max(existing.contextWindow, entry.model.contextWindow);
        } else if (entry.model.contextWindow) {
          existing.contextWindow = entry.model.contextWindow;
        }
      }
    }
    return [...listings.values()];
  }

  async close(): Promise<void> {
    await Promise.all(
      this.providers.map(async (provider) => {
        try {
          await provider.adapter.close?.();
        } catch (error) {
          log.warn(`关闭渠道 ${provider.id} 失败: ${(error as Error).message}`);
        }
      }),
    );
  }
}
