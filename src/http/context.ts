import type { ResolvedConfig } from '../config.js';
import type { ConcurrencyLimiter } from '../core/limiter.js';
import type { ModelCatalog } from '../core/model-catalog.js';
import type { PoolSupervisor } from '../core/pool-supervisor.js';
import type { Router } from '../core/router.js';
import type { Registry } from '../providers/registry.js';
import type { Store } from '../store/db.js';

export interface GatewayContext {
  config: ResolvedConfig;
  registry: Registry;
  router: Router;
  catalog: ModelCatalog;
  supervisor: PoolSupervisor;
  limiter: ConcurrencyLimiter;
  store: Store;
  startedAt: number;
  adminToken: string;
  configPath?: string;
  applyConfig: (config: ResolvedConfig) => Promise<void>;
}
