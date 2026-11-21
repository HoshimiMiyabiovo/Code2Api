import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.js';
import type { RequestRecord } from '../src/store/db.js';

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: `req_${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    endpoint: 'openai.chat',
    stream: true,
    requestedModel: 'test-model',
    provider: 'fake',
    keyLabel: 'main',
    status: 'ok',
    httpStatus: 200,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: false,
    attempts: 1,
    ...overrides,
  };
}

test('totals：openai 口径（cached ⊆ prompt）按差值拆未缓存输入', () => {
  const store = new Store(':memory:');
  store.recordRequest(record({ inputTokens: 370864, cacheReadTokens: 369920, outputTokens: 944 }));
  const totals = store.totals(0);
  // 未缓存 = 370864 - 369920；缓存读取独立一桶；生成 = 输出 + 推理。
  assert.equal(totals.uncachedInputTokens, 944);
  assert.equal(totals.cacheReadTokens, 369920);
  assert.equal(totals.generatedTokens, 944);
});

test('totals：桥接口径（cache_read > input）未缓存输入保持 input 原值', () => {
  const store = new Store(':memory:');
  // opencode 桥接的 input 不含缓存，cache_read 是独立累加（可远大于 input）。
  store.recordRequest(
    record({
      inputTokens: 75332,
      cacheReadTokens: 5225984,
      outputTokens: 18143,
      reasoningTokens: 35698,
    }),
  );
  const totals = store.totals(0);
  assert.equal(totals.uncachedInputTokens, 75332);
  assert.equal(totals.cacheReadTokens, 5225984);
  assert.equal(totals.generatedTokens, 18143 + 35698);
});

test('totals：小缓存命中与缓存写入、失败行一并计入', () => {
  const store = new Store(':memory:');
  store.recordRequest(record({ inputTokens: 9306, cacheReadTokens: 1792, cacheWriteTokens: 500 }));
  store.recordRequest(record({ status: 'cancelled', inputTokens: 1000, outputTokens: 50 }));
  const totals = store.totals(0);
  // 小缓存命中按 openai 口径扣减：9306 - 1792；cancelled 行的消耗也计入（上游真实消耗）。
  assert.equal(totals.uncachedInputTokens, 9306 - 1792 + 1000);
  assert.equal(totals.cacheWriteTokens, 500);
  assert.equal(totals.generatedTokens, 50);
  assert.equal(totals.cancelled, 1);
});
