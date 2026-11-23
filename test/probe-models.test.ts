import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

// 只提供 GET /models 的最小 openai-compatible 假上游（探测端点不发起对话请求）。
async function startFakeModels(
  models: Array<Record<string, unknown>>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

// 最小 opencode 假上游（external 模式）：Basic 鉴权 + /api/info 就绪 + /api/event SSE + /api/model 目录。
class FakeOpenCodeModels {
  private readonly server: Server;
  private readonly clients = new Set<ServerResponse>();
  readonly password = 'fake-oc-probe-pass';
  baseUrl = '';

  constructor(private readonly entries: Array<Record<string, unknown>>) {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const client of [...this.clients]) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private authorized(req: IncomingMessage): boolean {
    const expected = 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64');
    return req.headers.authorization === expected;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'auth required' } }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 'fake', pid: process.pid }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/event') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/model') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: this.entries }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  }
}

interface Harness {
  base: string;
  adminToken: string;
  gateway: Gateway;
  close: () => Promise<void>;
}

async function startGateway(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-probe-'));
  const dbPath = join(dir, 'gateway.db').replaceAll('\\', '/');
  const configPath = join(dir, 'config.yaml');
  writeFileSync(
    configPath,
    `
server:
  port: 0
admin:
  token: test-admin
storage:
  path: ${dbPath}
catalog:
  sync_enabled: false
providers:
  - id: mock
    type: mock
    models:
      - id: mock-chat
`,
    'utf8',
  );
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

async function adminJson(
  harness: Harness,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${harness.base}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${harness.adminToken}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

test('探测端点：openai-compatible 草稿拉取 /models，不污染 registry', async () => {
  const fake = await startFakeModels([
    { id: 'probe-me', context_length: 131072, supported_parameters: ['tools', 'reasoning'] },
    { id: 'plain-model' },
  ]);
  const harness = await startGateway();
  try {
    const probe = await adminJson(harness, '/admin/api/channels/probe-models', {
      method: 'POST',
      body: {
        id: 'probe-chan',
        type: 'openai-compatible',
        baseUrl: `${fake.baseUrl}/v1`,
        keys: [{ action: 'new', label: 'main', mode: 'key', key: 'sk-probe-test-1234' }],
        models: [],
      },
    });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.ok, true);
    const models = probe.body.models;
    assert.equal(models.length, 2);
    const probed = models.find((m: any) => m.id === 'probe-me');
    assert.equal(probed.upstream, 'probe-me');
    assert.equal(probed.contextWindow, 131072);
    assert.equal(probed.capabilities.tools, true);
    assert.equal(probed.capabilities.reasoning, true);
    const plain = models.find((m: any) => m.id === 'plain-model');
    // 未声明能力时按 catalog 非严格策略兜底：默认放行。
    assert.equal(plain.capabilities.tools, true);
    assert.equal(plain.capabilities.reasoning, true);
    // 响应不得包含密钥明文。
    assert.ok(!JSON.stringify(probe.body).includes('sk-probe-test-1234'));

    // 探测是只读预览：registry 里不应出现草稿渠道或同步进来的模型。
    const channels = await adminJson(harness, '/admin/api/channels');
    assert.equal(channels.body.channels.length, 1);
    assert.equal(channels.body.channels[0].id, 'mock');
    assert.equal(channels.body.channels[0].models.length, 1);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('探测端点：opencode 草稿拉取 /api/model 并过滤残影，回填 upstream', async () => {
  const fake = new FakeOpenCodeModels([
    {
      id: 'auto-model',
      modelID: 'auto-model',
      providerID: 'fake',
      type: 'chat',
      enabled: true,
      status: 'active',
      capabilities: { tools: true, input: ['text', 'image'] },
      limit: { context: 100000, output: 8192 },
      cost: [{ input: 1, output: 2, cache: { read: 0.5, write: 0 } }],
      variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }],
    },
    // 残影：缺 type 的条目必须被过滤（实际请求会返回 Model is unavailable）。
    { id: 'ghost', modelID: 'ghost', providerID: 'fake', enabled: true, status: 'active' },
    {
      id: 'fake-image',
      modelID: 'fake-image',
      providerID: 'fake',
      type: 'image',
      enabled: true,
      status: 'active',
    },
  ]);
  await fake.start();
  const harness = await startGateway();
  process.env.OPENCODE_SERVER_PASSWORD = fake.password;
  try {
    const probe = await adminJson(harness, '/admin/api/channels/probe-models', {
      method: 'POST',
      body: {
        id: 'probe-oc',
        type: 'opencode',
        baseUrl: fake.baseUrl,
        modelPrefixes: { 'fake/*': 'Go/' },
        models: [],
      },
    });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.ok, true);
    const models = probe.body.models;
    assert.equal(models.length, 1);
    // 候选对外名应用渠道前缀规则，upstream 保持原始限定名。
    assert.equal(models[0].id, 'Go/auto-model');
    assert.equal(models[0].upstream, 'fake/auto-model');
    assert.equal(models[0].contextWindow, 100000);
    assert.equal(models[0].maxOutputTokens, 8192);
    assert.equal(models[0].capabilities.vision, true);
    assert.equal(models[0].capabilities.reasoning, true);
    assert.equal(models[0].pricing.inputPerMtok, 1);
    assert.equal(models[0].pricing.outputPerMtok, 2);

    const channels = await adminJson(harness, '/admin/api/channels');
    assert.equal(channels.body.channels.length, 1);
  } finally {
    delete process.env.OPENCODE_SERVER_PASSWORD;
    await harness.close();
    await fake.close();
  }
});

test('探测端点：编辑中的渠道合并已存密钥（keep）后探测成功', async () => {
  const fake = await startFakeModels([{ id: 'kept-model' }]);
  const harness = await startGateway();
  try {
    const created = await adminJson(harness, '/admin/api/channels', {
      method: 'POST',
      body: {
        id: 'saved-chan',
        type: 'openai-compatible',
        baseUrl: `${fake.baseUrl}/v1`,
        keys: [{ action: 'new', label: 'main', mode: 'key', key: 'sk-saved-key-1234' }],
        models: [
          { id: 'placeholder', capabilities: { tools: true, vision: false, reasoning: false } },
        ],
      },
    });
    assert.equal(created.status, 200);
    // 渠道保存会触发自动模型同步（已有行为），这里先记录探测前的基线。
    const before = await adminJson(harness, '/admin/api/channels');
    const beforeModels = before.body.channels.find((c: any) => c.id === 'saved-chan').models;

    // 面板编辑场景：草稿不带明文密钥，只传 keep，服务端合并已存密钥后探测。
    const probe = await adminJson(harness, '/admin/api/channels/probe-models', {
      method: 'POST',
      body: {
        id: 'saved-chan',
        type: 'openai-compatible',
        baseUrl: `${fake.baseUrl}/v1`,
        keys: [{ action: 'keep', label: 'main' }],
        models: [],
      },
    });
    assert.equal(probe.status, 200);
    assert.deepEqual(
      probe.body.models.map((m: any) => m.id),
      ['kept-model'],
    );

    // 探测不改已保存渠道的模型列表（与探测前基线一致）。
    const channels = await adminJson(harness, '/admin/api/channels');
    const saved = channels.body.channels.find((c: any) => c.id === 'saved-chan');
    assert.deepEqual(saved.models, beforeModels);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('探测端点：0 模型草稿可探测，保存路径仍要求至少一个模型', async () => {
  const fake = await startFakeModels([{ id: 'draft-only' }]);
  const harness = await startGateway();
  try {
    const draft = {
      id: 'draft-chan',
      type: 'openai-compatible',
      baseUrl: `${fake.baseUrl}/v1`,
      keys: [{ action: 'new', label: 'main', mode: 'key', key: 'sk-draft-key-1234' }],
      models: [],
    };
    const probe = await adminJson(harness, '/admin/api/channels/probe-models', {
      method: 'POST',
      body: draft,
    });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.models.length, 1);

    const save = await adminJson(harness, '/admin/api/channels', {
      method: 'POST',
      body: draft,
    });
    assert.equal(save.status, 400);
    assert.match(save.body.error.message, /至少配置一个模型/);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('探测端点：zcode 无模型目录返回明确提示，缺 id / base_url 校验失败', async () => {
  const harness = await startGateway();
  try {
    const zcode = await adminJson(harness, '/admin/api/channels/probe-models', {
      method: 'POST',
      body: { id: 'probe-zc', type: 'zcode', models: [] },
    });
    assert.equal(zcode.status, 400);
    assert.match(zcode.body.error.message, /providerId\/modelId/);

    const noId = await adminJson(harness, '/admin/api/channels/probe-models', {
      method: 'POST',
      body: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', models: [] },
    });
    assert.equal(noId.status, 400);

    const noBaseUrl = await adminJson(harness, '/admin/api/channels/probe-models', {
      method: 'POST',
      body: { id: 'no-base', type: 'openai-compatible', models: [] },
    });
    assert.equal(noBaseUrl.status, 400);
    assert.match(noBaseUrl.body.error.message, /base_url/);
  } finally {
    await harness.close();
  }
});
