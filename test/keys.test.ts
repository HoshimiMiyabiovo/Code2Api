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

test('超时/网络/5xx 连续失败用固定基数冷却，不指数递增', () => {
  const pool = new KeyPool([{ label: 'main', key: 'sk-test' }]);
  for (const category of ['timeout', 'network', 'server'] as const) {
    const expected = category === 'server' ? 15_000 : 10_000;
    pool.markSuccess(pool.keys[0]); // 重置上一类别残留的连败计数
    for (let round = 1; round <= 4; round += 1) {
      const key = pool.keys[0];
      pool.markAttempt(key);
      pool.markFailure(key, category, cooldowns);
      const actual = remaining(pool);
      assert.ok(
        Math.abs(actual - expected) < 1000,
        `${category} 第 ${round} 次连败：expected ~${expected}ms, got ${actual}ms`,
      );
    }
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

test('clearCooldowns 立即解除冷却与连续失败计数', () => {
  const pool = new KeyPool([
    { label: 'main', key: 'sk-test' },
    { label: 'spare', key: 'sk-spare' },
  ]);
  markRateLimit(pool);
  markRateLimit(pool);
  // 第二个密钥也打入冷却
  pool.markAttempt(pool.keys[1]);
  pool.markFailure(pool.keys[1], 'rate_limit', cooldowns);
  assert.equal(pool.clearCooldowns(), 2);
  for (const key of pool.keys) {
    assert.equal(key.cooldownUntil, 0);
    assert.equal(key.consecutiveFailures, 0);
  }
  assert.equal(pool.earliestCooldown(), null);
  // 再次失败应从基数开始，而不是接着翻倍
  markRateLimit(pool);
  const actual = remaining(pool);
  assert.ok(
    Math.abs(actual - 60_000) < 1000,
    `expected ~60000ms (base after clear), got ${actual}ms`,
  );
  // 没有冷却时重复调用返回 0
  assert.equal(pool.clearCooldowns(), 1);
  assert.equal(pool.clearCooldowns(), 0);
});

test('无密钥池（no-auth）也可安全清空', () => {
  const pool = new KeyPool([]);
  assert.equal(pool.clearCooldowns(), 0);
  assert.deepEqual(pool.snapshot().map((key) => key.status), ['ready']);
});
