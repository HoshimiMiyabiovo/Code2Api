import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

interface ChatRecord {
  auth: string;
  body: Record<string, unknown>;
}

async function startFake(): Promise<{
  baseUrl: string;
  chats: ChatRecord[];
  close: () => Promise<void>;
}> {
  const chats: ChatRecord[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const auth = String(req.headers.authorization ?? '');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (auth.includes('key-a')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'models unavailable' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'shared' }] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/quota-a') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { remaining_percent: 0 } }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/quota-b') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { remaining_percent: 80 } }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // ignore
      }
      chats.push({ auth, body });
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
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    chats,
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
  adminToken: string;
  gateway: Gateway;
  close: () => Promise<void>;
}

async function startGateway(yaml: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-monitor-'));
  const dbPath = join(dir, 'gateway.db').replaceAll('\\', '/');
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, yaml.replaceAll('__DB__', dbPath), 'utf8');
  const config = loadConfig(configPath);
  const gateway = await createGateway(config, { configPath });
  await gateway.app.listen({ host: '127.0.0.1', port: 0 });
  const address = gateway.app.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    adminToken: gateway.ctx.adminToken,
    gateway,
    close: async () => {
      await gateway.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('主动探活、额度轮询路由跳过、保活触发', async () => {
  const fake = await startFake();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
catalog:
  sync_enabled: false
health:
  enabled: true
  interval_ms: 3600000
  timeout_ms: 5000
providers:
  - id: provider-a
    type: openai-compatible
    priority: 10
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: main
        key: key-a
    quota:
      enabled: true
      url: ${fake.baseUrl}/quota-a
      interval_ms: 60000
      remaining_path: data.remaining_percent
    models:
      - id: shared
        upstream: up-shared
  - id: provider-b
    type: openai-compatible
    priority: 20
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: main
        key: key-b
    quota:
      enabled: true
      url: ${fake.baseUrl}/quota-b
      interval_ms: 60000
      remaining_path: data.remaining_percent
    keepalive:
      enabled: true
      interval_ms: 3600000
      model: shared
      max_tokens: 4
      prompt: keepalive-ping
    models:
      - id: shared
        upstream: up-shared
`);
  try {
    const probe = await fetch(`${harness.base}/admin/api/maintenance/probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${harness.adminToken}` },
    });
    assert.equal(probe.status, 200);
    const probeBody = await probe.json();
    assert.equal(probeBody.providers['provider-a'].health.status, 'unhealthy');
    assert.equal(probeBody.providers['provider-b'].health.status, 'healthy');
    assert.equal(probeBody.providers['provider-a'].quota.remainingPercent, 0);
    assert.equal(probeBody.providers['provider-b'].quota.remainingPercent, 80);

    const chat = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'shared',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 8,
      }),
    });
    assert.equal(chat.status, 200);
    const body = await chat.json();
    assert.equal(body.choices[0].message.content, 'Hello');
    assert.ok(fake.chats[0]?.auth.includes('key-b'));

    const keepalive = await fetch(`${harness.base}/admin/api/maintenance/keepalive`, {
      method: 'POST',
      headers: { authorization: `Bearer ${harness.adminToken}` },
    });
    assert.equal(keepalive.status, 200);
    const keepaliveBody = await keepalive.json();
    assert.equal(keepaliveBody.providers['provider-b'].keepalive.ok, true);
    const keepaliveChat = fake.chats.find(
      (item) =>
        Array.isArray(item.body.messages) &&
        String((item.body.messages as any[])[0]?.content ?? '').includes('keepalive-ping'),
    );
    assert.ok(keepaliveChat);
    assert.ok(keepaliveChat?.auth.includes('key-b'));
  } finally {
    await harness.close();
    await fake.close();
  }
});
