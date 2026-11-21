import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool } from '../src/core/keys.js';
import type { CooldownConfig } from '../src/config.js';

const cooldowns: CooldownConfig = {
  authMs: 600_000,
  rateLimitMs: 60_000,
  paymentMs: 600_000,
  serverMs: 15_000,
  networkMs: 10_000,
  emptyStreamMs: 5_000,
  maxMs: 1_800_000,
};

function remaining(pool: KeyPool, label = 'main'): number {
  const key = pool.keys.find((item) => item.label === label);
  assert.ok(key, `key ${label} 不存在`);
  return key.cooldownUntil - Date.now();
}

function markRateLimit(pool: KeyPool, retryAfterMs?: number): void {
  const key = pool.keys[0];
  pool.markAttempt(key);
  pool.markFailure(key, 'rate_limit', cooldowns, retryAfterMs);
}

test('连续失败指数翻倍，封顶 2^3（8 倍基数）', () => {
  const pool = new KeyPool([{ label: 'main', key: 'sk-test' }]);
  const expected = [60_000, 120_000, 240_000, 480_000, 480_000, 480_000];
  for (const ms of expected) {
    markRateLimit(pool);
    const actual = remaining(pool);
    assert.ok(
      Math.abs(actual - ms) < 1000,
      `expected ~${ms}ms cooldown, got ${actual}ms`,
    );
  }
});

test('上游给出 Retry-After 时直接采用，不与指数取 max', () => {
  const pool = new KeyPool([{ label: 'main', key: 'sk-test' }]);
  // 先连败两次，指数已是 240s
  markRateLimit(pool);
  markRateLimit(pool);
  // 上游说 5s 后重试 → 冷却应为 5s，而不是 max(240s, 5s)
  markRateLimit(pool, 5_000);
  const actual = remaining(pool);
  assert.ok(
    Math.abs(actual - 5_000) < 500,
    `expected ~5000ms (upstream retry-after), got ${actual}ms`,
  );
});

test('Retry-After 超过 maxMs 时仍被本地封顶', () => {
  const pool = new KeyPool([{ label: 'main', key: 'sk-test' }]);
  const tight: CooldownConfig = { ...cooldowns, maxMs: 30_000 };
  const key = pool.keys[0];
  pool.markAttempt(key);
  pool.markFailure(key, 'rate_limit', tight, 3_600_000);
  const actual = remaining(pool);
  assert.ok(
    Math.abs(actual - 30_000) < 500,
    `expected ~30000ms (maxMs cap), got ${actual}ms`,
  );
});

test('成功后清零连续失败，下次失败回到基数', () => {
  const pool = new KeyPool([{ label: 'main', key: 'sk-test' }]);
  markRateLimit(pool);
  markRateLimit(pool);
  pool.markSuccess(pool.keys[0]);
  assert.equal(pool.keys[0].consecutiveFailures, 0);
  assert.ok(remaining(pool) <= 0, 'success should clear cooldown');
  markRateLimit(pool);
  const actual = remaining(pool);
  assert.ok(
    Math.abs(actual - 60_000) < 1000,
    `expected ~60000ms (base), got ${actual}ms`,
  );
});
