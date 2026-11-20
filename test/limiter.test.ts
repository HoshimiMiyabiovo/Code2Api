import test from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyLimiter } from '../src/core/limiter.js';

test('全局并发限制：排队、超时拒绝与释放', async () => {
  const limiter = new ConcurrencyLimiter(1, 80);
  const first = await limiter.acquire();
  await assert.rejects(limiter.acquire(), /并发已满/);
  first();
  assert.equal(limiter.snapshot().active, 0);

  const second = await limiter.acquire();
  const queued = limiter.acquire();
  setTimeout(() => second(), 20);
  const third = await queued;
  assert.equal(limiter.snapshot().active, 1);
  third();
  assert.equal(limiter.snapshot().active, 0);
  assert.equal(limiter.snapshot().queued, 0);
});
