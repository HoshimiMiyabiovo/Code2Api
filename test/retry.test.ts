import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

type Reply = '429' | '429-retry' | '400' | '200' | 'stream' | 'hang';

interface FakeUpstream {
  baseUrl: string;
  calls: () => number;
  callTimes: () => number[];
  waitForCalls: (count: number) => Promise<void>;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

function startFake(sequence: Reply[]): Promise<FakeUpstream> {
  const calls: number[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const server: Server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    calls.push(Date.now());
    const reply = sequence[Math.min(calls.length - 1, sequence.length - 1)] ?? '200';
    if (reply === 'hang') {
      // 故意不响应：模拟上游挂起，由网关的 ttfb 超时主动断开
      return;
    }
    if (reply === '429') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    } else if (reply === '429-retry') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '0.05',
      });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    } else if (reply === '400') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad request' } }));
    } else if (reply === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ id: 'up', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      send({ id: 'up', model: body.model, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] });
      send({ id: 'up', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fake',
          object: 'chat.completion',
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
    for (const waiter of [...waiters]) {
      if (calls.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        calls: () => calls.length,
        callTimes: () => calls.slice(),
        waitForCalls: (count) =>
          calls.length >= count
            ? Promise.resolve()
            : new Promise((done) => waiters.push({ count, resolve: done })),
        close: async () => {
          await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

interface Harness {
  base: string;
  gateway: Gateway;
  close: () => Promise<void>;
}

async function startGateway(yaml: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-retry-'));
  const dbPath = join(dir, 'gateway.db').replaceAll('\\', '/');
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, yaml.replaceAll('__DB__', dbPath), 'utf8');
  const config = loadConfig(configPath);
  const gateway = await createGateway(config, { configPath });
  await gateway.app.listen({ host: '127.0.0.1', port: 0 });
  const address = gateway.app.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    gateway,
    close: async () => {
      await gateway.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function configFor(
  fake: FakeUpstream,
  options: {
    rateLimitCooldownMs?: number;
    networkCooldownMs?: number;
    maxRetries?: number;
    maxTotalWaitMs?: number;
    ttfbMs?: number;
  } = {},
): string {
  return `
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
catalog:
  sync_enabled: false
health:
  enabled: false
routing:
  max_attempts: 1
  cooldowns:
    rate_limit_ms: ${options.rateLimitCooldownMs ?? 50}
    network_ms: ${options.networkCooldownMs ?? 10000}
  retry:
    enabled: true
    max_retries: ${options.maxRetries ?? 2}
    initial_delay_ms: 5
    max_delay_ms: 50
    jitter_ratio: 0
    retry_on: [rate_limit, server, timeout, network, empty_stream]
    respect_retry_after: true
    max_total_wait_ms: ${options.maxTotalWaitMs ?? 1000}
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    timeouts:
      connect_ms: 1000
      ttfb_ms: ${options.ttfbMs ?? 60000}
      idle_ms: 120000
      total_ms: 600000
    keys:
      - label: main
        key: ok-key
    models:
      - id: m
        upstream: m
        capabilities:
          tools: true
          vision: false
          reasoning: false
`;
}

async function chat(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string; body: any }> {
  const response = await fetch(`${harness.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: response.status, text, body: parsed };
}

test('429 后等待密钥冷却并重试成功', async () => {
  const fake = await startFake(['429', '200']);
  const harness = await startGateway(
    configFor(fake, { rateLimitCooldownMs: 50 }),
  );
  try {
    const response = await chat(harness, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.equal(fake.calls(), 2);
    const gap = fake.callTimes()[1]! - fake.callTimes()[0]!;
    assert.ok(gap >= 40, `expected cooldown wait, got ${gap}ms`);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('全渠道冷却时并发请求等待恢复而不是 503', async () => {
  const fake = await startFake(['429', '200', '200']);
  const harness = await startGateway(
    configFor(fake, { rateLimitCooldownMs: 80, maxTotalWaitMs: 2000 }),
  );
  try {
    const first = chat(harness, {
      model: 'm',
      messages: [{ role: 'user', content: 'first' }],
    });
    await fake.waitForCalls(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = chat(harness, {
      model: 'm',
      messages: [{ role: 'user', content: 'second' }],
    });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(fake.calls(), 3);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('不可重试的 400 不等待也不重试', async () => {
  const fake = await startFake(['400', '200']);
  const harness = await startGateway(configFor(fake));
  try {
    const response = await chat(harness, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 400);
    assert.equal(fake.calls(), 1);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('重试预算耗尽后返回最后一次错误', async () => {
  const fake = await startFake(['429']);
  const harness = await startGateway(
    configFor(fake, { rateLimitCooldownMs: 20, maxRetries: 1, maxTotalWaitMs: 500 }),
  );
  try {
    const response = await chat(harness, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 429);
    assert.equal(fake.calls(), 2);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('重试设置可通过 admin API 保存并热加载', async () => {
  const fake = await startFake(['200']);
  const harness = await startGateway(configFor(fake));
  const headers = {
    authorization: 'Bearer test-admin',
    'content-type': 'application/json',
  };
  try {
    const before = await fetch(`${harness.base}/admin/api/retry`, { headers }).then((r) => r.json());
    assert.equal(before.retry.enabled, true);
    assert.equal(before.retry.maxRetries, 2);

    const save = await fetch(`${harness.base}/admin/api/retry`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        enabled: true,
        maxRetries: 3,
        initialDelayMs: 100,
        maxDelayMs: 2000,
        jitterRatio: 0.2,
        retryOn: ['rate_limit', 'server'],
        respectRetryAfter: true,
        maxTotalWaitMs: 60000,
      }),
    });
    assert.equal(save.status, 200);

    const after = await fetch(`${harness.base}/admin/api/retry`, { headers }).then((r) => r.json());
    assert.equal(after.retry.maxRetries, 3);
    assert.deepEqual(after.retry.retryOn, ['rate_limit', 'server']);
    assert.equal(after.retry.maxTotalWaitMs, 60000);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('流式请求在首包前遇到 429 也会重试', async () => {
  const fake = await startFake(['429', 'stream']);
  const harness = await startGateway(
    configFor(fake, { rateLimitCooldownMs: 30 }),
  );
  try {
    const response = await chat(harness, {
      model: 'm',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.match(response.text, /Hello/);
    assert.equal(fake.calls(), 2);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('429 带 Retry-After 时按上游窗口冷却，不与指数取 max', async () => {
  const fake = await startFake(['429-retry', '200']);
  const harness = await startGateway(
    configFor(fake, { rateLimitCooldownMs: 2000 }),
  );
  try {
    const response = await chat(harness, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.equal(fake.calls(), 2);
    const gap = fake.callTimes()[1]! - fake.callTimes()[0]!;
    // retry-after: 0.05 → 上游窗口约 50ms；旧语义会等 max(2000ms 基数, 50ms)
    assert.ok(gap < 1000, `expected ~50ms upstream window, got ${gap}ms`);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('冷却剩余超出等待预算时立即 503 且错误信息带诊断', async () => {
  const fake = await startFake(['429', '429']);
  const harness = await startGateway(
    configFor(fake, { rateLimitCooldownMs: 3000, maxTotalWaitMs: 500 }),
  );
  try {
    // 第一笔：尝试 1 次 → 429 → 冷却 3000ms 超出剩余预算 → 耗尽
    const first = await chat(harness, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(first.status, 429);
    assert.equal(fake.calls(), 1);
    // 第二笔：冷却剩余远大于预算 → 不等待直接 503，且不重复打上游
    const second = await chat(harness, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(second.status, 503);
    assert.equal(fake.calls(), 1);
    assert.match(
      String(second.body?.error?.message ?? ''),
      /当前无可用渠道（渠道冷却剩余时长超出单请求等待预算，本轮未尝试上游）/,
    );
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('上游持续超时时按墙钟预算快速失败（尝试耗时计入预算）', async () => {
  const fake = await startFake(['hang']);
  const harness = await startGateway(
    configFor(fake, {
      networkCooldownMs: 100,
      maxRetries: 5,
      maxTotalWaitMs: 300,
      ttfbMs: 60,
    }),
  );
  try {
    const started = Date.now();
    const response = await chat(harness, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 504);
    // 旧语义（只计睡眠）：waitedMs 返在预算内会继续重试第 3 次；
    // 墙钟预算下两次 60ms 超时后已越线 → 最多 2 次尝试即报错。
    assert.ok(fake.calls() <= 2, `expected ≤2 attempts, got ${fake.calls()}`);
    assert.ok(elapsed < 2000, `expected fast failure, took ${elapsed}ms`);
    assert.match(
      String(response.body?.error?.message ?? ''),
      /所有渠道均失败/,
    );
  } finally {
    await harness.close();
    await fake.close();
  }
});
