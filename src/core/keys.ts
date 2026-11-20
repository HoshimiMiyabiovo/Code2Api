import type { CooldownConfig, KeyConfig } from '../config.js';
import type { FailureCategory } from '../errors.js';

export interface KeyRuntime {
  label: string;
  key: string | null;
  missingEnv?: string;
  cooldownUntil: number;
  consecutiveFailures: number;
  lastUsedAt: number | null;
  attempts: number;
  failures: number;
}

export interface KeySnapshot {
  label: string;
  masked: string;
  status: 'ready' | 'cooling' | 'missing_env';
  cooldownRemainingMs: number;
  consecutiveFailures: number;
  attempts: number;
  failures: number;
  lastUsedAt: number | null;
}

export function maskKey(key: string | null | undefined): string {
  if (!key) return '***';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

function newKeyState(key: KeyConfig): KeyRuntime {
  return {
    label: key.label,
    key: key.key,
    missingEnv: key.missingEnv,
    cooldownUntil: 0,
    consecutiveFailures: 0,
    lastUsedAt: null,
    attempts: 0,
    failures: 0,
  };
}

function baseCooldownMs(category: FailureCategory, cd: CooldownConfig): number {
  switch (category) {
    case 'auth':
      return cd.authMs;
    case 'rate_limit':
      return cd.rateLimitMs;
    case 'payment':
      return cd.paymentMs;
    case 'server':
      return cd.serverMs;
    case 'network':
    case 'timeout':
      return cd.networkMs;
    case 'empty_stream':
      return cd.emptyStreamMs;
    default:
      return 0;
  }
}

export class KeyPool {
  readonly keys: KeyRuntime[];
  private readonly noAuthKey: KeyRuntime | null;
  private cursor = 0;

  constructor(keys: KeyConfig[]) {
    this.keys = keys.map(newKeyState);
    this.noAuthKey =
      keys.length === 0
        ? {
            label: 'no-auth',
            key: '',
            cooldownUntil: 0,
            consecutiveFailures: 0,
            lastUsedAt: null,
            attempts: 0,
            failures: 0,
          }
        : null;
  }

  attemptOrder(now = Date.now()): KeyRuntime[] {
    if (this.noAuthKey) return [this.noAuthKey];
    const ready = this.keys.filter((k) => k.key !== null && k.cooldownUntil <= now);
    if (ready.length === 0) return [];
    const start = this.cursor % ready.length;
    this.cursor += 1;
    return [...ready.slice(start), ...ready.slice(0, start)];
  }

  markAttempt(key: KeyRuntime): void {
    key.attempts += 1;
    key.lastUsedAt = Date.now();
  }

  markSuccess(key: KeyRuntime): void {
    key.consecutiveFailures = 0;
    key.cooldownUntil = 0;
  }

  markFailure(
    key: KeyRuntime,
    category: FailureCategory,
    cooldowns: CooldownConfig,
    retryAfterMs?: number,
  ): void {
    key.failures += 1;
    if (key === this.noAuthKey) return;
    const base = baseCooldownMs(category, cooldowns);
    if (base <= 0) return;
    key.consecutiveFailures += 1;
    const exponent = Math.min(key.consecutiveFailures - 1, 5);
    const backoff = Math.min(base * 2 ** exponent, cooldowns.maxMs);
    key.cooldownUntil = Date.now() + Math.max(backoff, retryAfterMs ?? 0);
  }

  earliestCooldown(now = Date.now()): number | null {
    let earliest: number | null = null;
    for (const key of this.keys) {
      if (key.key === null) continue;
      if (key.cooldownUntil <= now) continue;
      if (earliest === null || key.cooldownUntil < earliest) earliest = key.cooldownUntil;
    }
    return earliest;
  }

  hasUsableKey(): boolean {
    if (this.noAuthKey) return true;
    return this.keys.some((k) => k.key !== null);
  }

  snapshot(now = Date.now()): KeySnapshot[] {
    const source = this.noAuthKey ? [this.noAuthKey] : this.keys;
    return source.map((key) => {
      let status: KeySnapshot['status'];
      if (this.noAuthKey) status = 'ready';
      else if (key.key === null) status = 'missing_env';
      else if (key.cooldownUntil > now) status = 'cooling';
      else status = 'ready';
      return {
        label: key.label,
        masked: this.noAuthKey
          ? '—'
          : key.missingEnv
            ? `missing env: ${key.missingEnv}`
            : maskKey(key.key),
        status,
        cooldownRemainingMs: Math.max(0, key.cooldownUntil - now),
        consecutiveFailures: key.consecutiveFailures,
        attempts: key.attempts,
        failures: key.failures,
        lastUsedAt: key.lastUsedAt,
      };
    });
  }
}
