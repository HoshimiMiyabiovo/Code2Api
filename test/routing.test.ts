import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

async function startFake(): Promise<{
  baseUrl: string;
  models: string[];
  close: () => Promise<void>;
}> {
  const models: string[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // ignore
    }
    models.push(String(body.model ?? ''));
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
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    models,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

interface Harness {
  base: string;
  gateway: Gateway;
  close: () => Promise<void>;
}

async function startGateway(yaml: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-routing-'));
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

async function chat(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
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
  return { status: response.status, body: parsed };
}

test('上下文窗口路由：超窗直接拒绝，不请求上游', async () => {
  const fake = await startFake();
  const harness = await startGateway(`
server:
  port: 0
storage:
  path: __DB__
catalog:
  sync_enabled: false
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: main
        key: ok-key
    models:
      - id: small
        upstream: up-small
        context_window: 120
        capabilities:
          tools: true
          vision: false
          reasoning: false
`);
  try {
    const response = await chat(harness, {
      model: 'small',
      max_tokens: 512,
      messages: [{ role: 'user', content: 'x'.repeat(2000) }],
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'context_window_exceeded');
    assert.equal(fake.models.length, 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('模型别名与黑名单：精确/通配别名、拦截', async () => {
  const fake = await startFake();
  const harness = await startGateway(`
server:
  port: 0
storage:
  path: __DB__
catalog:
  sync_enabled: false
routing:
  model_aliases:
    fast: large
    "team/*": "large-$1"
  model_blacklist:
    - "blocked-*"
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: main
        key: ok-key
    models:
      - id: large
        upstream: up-large
        context_window: 100000
        capabilities:
          tools: true
          vision: false
          reasoning: false
      - id: large-x
        upstream: up-large-x
        context_window: 100000
        capabilities:
          tools: true
          vision: false
          reasoning: false
`);
  try {
    const exact = await chat(harness, {
      model: 'fast',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(exact.status, 200);
    assert.equal(fake.models.at(-1), 'up-large');

    const wildcard = await chat(harness, {
      model: 'team/x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(wildcard.status, 200);
    assert.equal(fake.models.at(-1), 'up-large-x');

    const blocked = await chat(harness, {
      model: 'blocked-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, 'model_blocked');

    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    const ids = models.data.map((m: any) => m.id);
    assert.ok(ids.includes('fast'));
    assert.ok(!ids.includes('team/*'));
    assert.ok(!ids.some((id: string) => id.startsWith('blocked-')));
  } finally {
    await harness.close();
    await fake.close();
  }
});
