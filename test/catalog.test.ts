import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

interface FakeOptions {
  models?: Array<
    string | { id: string; context_length?: number; supported_parameters?: string[] }
  >;
  rejectReasoning?: boolean;
}

interface FakeUpstream {
  baseUrl: string;
  bodies: Record<string, unknown>[];
  setModels: (models: NonNullable<FakeOptions['models']>) => void;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

async function startFake(options: FakeOptions = {}): Promise<FakeUpstream> {
  const bodies: Record<string, unknown>[] = [];
  let currentModels = options.models ?? [];
  const server: Server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      const models = currentModels.map((item) =>
        typeof item === 'string'
          ? { id: item, object: 'model', owned_by: 'fake' }
          : {
              id: item.id,
              object: 'model',
              owned_by: 'fake',
              context_length: item.context_length,
              supported_parameters: item.supported_parameters,
            },
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    bodies.push(body);

    const hasReasoning =
      body.reasoning_effort !== undefined ||
      body.reasoning_max_tokens !== undefined ||
      (body as { reasoning?: unknown }).reasoning !== undefined;
    if (options.rejectReasoning && hasReasoning) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown field reasoning_effort' } }));
      return;
    }

    const model = String(body.model ?? 'unknown');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m: any) => m?.role === 'user');
    const userText =
      lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';

    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ id: 'fake-stream', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      send({ id: 'fake-stream', model, choices: [{ index: 0, delta: { content: `Hello ${userText}` }, finish_reason: null }] });
      send({ id: 'fake-stream', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'fake-1',
        object: 'chat.completion',
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `Hello ${userText}` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    bodies,
    setModels: (models) => {
      currentModels = models;
    },
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
  configPath: string;
  gateway: Gateway;
  close: () => Promise<void>;
}

async function startGateway(yaml: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-catalog-'));
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
    configPath,
    gateway,
    close: async () => {
      await gateway.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function adminGet(harness: Harness, path: string): Promise<any> {
  const response = await fetch(`${harness.base}${path}`, {
    headers: { authorization: `Bearer ${harness.adminToken}` },
  });
  assert.equal(response.status, 200);
  return response.json();
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
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

test('模型目录同步：拉取上游 /models 并合并，手工配置优先', async () => {
  const fake = await startFake({
    models: [
      { id: 'sync-new-model', supported_parameters: ['tools', 'reasoning'] },
      { id: 'upstream-model', context_length: 131072 },
      { id: 'ctx-model', context_length: 200000, supported_parameters: ['tools'] },
    ],
  });
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
catalog:
  sync_enabled: true
  sync_on_start: true
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: configured
        upstream: upstream-model
        capabilities:
          tools: true
          vision: false
          reasoning: true
        reasoning_effort: high
`);
  try {
    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    const ids = models.data.map((m: any) => m.id).sort();
    assert.deepEqual(ids, ['configured', 'ctx-model', 'sync-new-model']);

    const admin = await adminGet(harness, '/admin/api/models');
    const synced = admin.models.find((m: any) => m.id === 'sync-new-model');
    assert.equal(synced.source, 'upstream');
    assert.equal(synced.contextWindow, null);
    assert.equal(synced.capabilities.reasoning, true);
    const manual = admin.models.find((m: any) => m.id === 'configured');
    assert.equal(manual.source, 'config');
    assert.equal(manual.capabilities.reasoning, true);
    assert.equal(manual.contextWindow, 131072);
    const withContext = admin.models.find((m: any) => m.id === 'ctx-model');
    assert.equal(withContext.source, 'upstream');
    assert.equal(withContext.contextWindow, 200000);
    assert.equal(withContext.capabilities.reasoning, false);
    assert.equal(admin.sync.lastAdded, 2);

    const response = await chat(harness, {
      model: 'sync-new-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].message.content, 'Hello hi');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('上下文窗口自动最大值：留空取目录最大，手工值优先', async () => {
  const fake = await startFake({
    models: [{ id: 'grow-model', context_length: 131072 }],
  });
  const yaml = `
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
catalog:
  sync_enabled: true
  sync_on_start: true
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: pinned
        upstream: grow-model
        context_window: 1000000
        capabilities:
          tools: true
`;
  const harness = await startGateway(yaml);
  try {
    // 手工条目留空的 auto-grow 由目录发现；pinned 手工 1M 不被目录 131072 覆盖。
    fake.setModels([
      { id: 'grow-model', context_length: 131072 },
      { id: 'auto-grow', context_length: 131072 },
    ]);
    // 通过渠道保存触发热加载 + 重新同步（与面板行为一致）。
    const save = async () => {
      const response = await fetch(`${harness.base}/admin/api/channels/fake`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${harness.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: 'fake',
          type: 'openai-compatible',
          baseUrl: `${fake.baseUrl}/v1`,
          keys: [{ action: 'keep', label: 'good' }],
          models: [
            {
              id: 'pinned',
              upstream: 'grow-model',
              contextWindow: 1000000,
              capabilities: { tools: true },
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 300));
    };
    await save();
    let admin = await adminGet(harness, '/admin/api/models');
    assert.equal(
      admin.models.find((m: any) => m.id === 'auto-grow').contextWindow,
      131072,
    );
    assert.equal(admin.models.find((m: any) => m.id === 'pinned').contextWindow, 1000000);

    // 目录声明变大：auto-grow 自动升到 262144；pinned 保持手工 1M。
    fake.setModels([
      { id: 'grow-model', context_length: 262144 },
      { id: 'auto-grow', context_length: 262144 },
    ]);
    await save();
    admin = await adminGet(harness, '/admin/api/models');
    assert.equal(
      admin.models.find((m: any) => m.id === 'auto-grow').contextWindow,
      262144,
    );
    assert.equal(admin.models.find((m: any) => m.id === 'pinned').contextWindow, 1000000);

    // 目录声明回落：热加载重建后回到当前目录声明值（262144 → 65536）。
    fake.setModels([
      { id: 'grow-model', context_length: 65536 },
      { id: 'auto-grow', context_length: 65536 },
    ]);
    await save();
    admin = await adminGet(harness, '/admin/api/models');
    assert.equal(
      admin.models.find((m: any) => m.id === 'auto-grow').contextWindow,
      65536,
    );
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('按能力过滤路由：tools / vision / reasoning', async () => {
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
providers:
  - id: cap-a
    type: openai-compatible
    priority: 10
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: shared
        upstream: up-a
        capabilities:
          tools: true
          vision: false
          reasoning: false
      - id: plain
        upstream: up-plain
        capabilities:
          tools: false
          vision: false
          reasoning: false
  - id: cap-b
    type: openai-compatible
    priority: 20
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: shared
        upstream: up-b
        capabilities:
          tools: false
          vision: true
          reasoning: true
`);
  try {
    const toolsResponse = await chat(harness, {
      model: 'shared',
      messages: [{ role: 'user', content: 'tool' }],
      tools: [
        {
          type: 'function',
          function: { name: 'f', parameters: { type: 'object', properties: {} } },
        },
      ],
    });
    assert.equal(toolsResponse.status, 200);
    assert.equal(toolsResponse.body.choices[0].message.content, 'Hello tool');

    const visionResponse = await chat(harness, {
      model: 'shared',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    assert.equal(visionResponse.status, 200);

    const reasoningResponse = await chat(harness, {
      model: 'shared',
      messages: [{ role: 'user', content: '想想' }],
      reasoning_effort: 'high',
    });
    assert.equal(reasoningResponse.status, 200);

    const requests = await adminGet(harness, '/admin/api/requests?range=24h&limit=10');
    const providers = requests.requests.map((r: any) => r.provider).sort();
    assert.deepEqual(providers, ['cap-a', 'cap-b', 'cap-b']);

    const mismatch = await chat(harness, {
      model: 'plain',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          function: { name: 'f', parameters: { type: 'object', properties: {} } },
        },
      ],
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'capability_mismatch');
    assert.match(mismatch.body.error.message, /tools/);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('推理强度自动注入：模型/渠道默认 effort，客户端可覆盖', async () => {
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
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    default_reasoning_effort: medium
    keys:
      - label: good
        key: ok-key
    models:
      - id: think-model
        upstream: upstream-model
        capabilities:
          tools: true
          vision: false
          reasoning: true
      - id: plain-model
        upstream: upstream-model
        capabilities:
          tools: true
          vision: false
          reasoning: false
`);
  try {
    const implicit = await chat(harness, {
      model: 'think-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(implicit.status, 200);
    assert.equal(fake.bodies.at(-1)?.reasoning_effort, 'medium');

    const explicit = await chat(harness, {
      model: 'think-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    });
    assert.equal(explicit.status, 200);
    assert.equal(fake.bodies.at(-1)?.reasoning_effort, 'high');

    const custom = await chat(harness, {
      model: 'think-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
    });
    assert.equal(custom.status, 200);
    assert.equal(fake.bodies.at(-1)?.reasoning_effort, 'xhigh');

    const plain = await chat(harness, {
      model: 'plain-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(plain.status, 200);
    assert.equal(fake.bodies.at(-1)?.reasoning_effort, undefined);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('Anthropic thinking.budget_tokens 透传到上游字段', async () => {
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
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    reasoning_budget_field: reasoning.max_tokens
    keys:
      - label: good
        key: ok-key
    models:
      - id: claude-like
        upstream: upstream-model
        capabilities:
          tools: true
          vision: false
          reasoning: true
`);
  try {
    const response = await fetch(`${harness.base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-like',
        max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 2048 },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = fake.bodies.at(-1) as { reasoning?: { max_tokens?: number } } | undefined;
    assert.equal(body?.reasoning?.max_tokens, 2048);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('上游拒绝 reasoning 字段时自动剥离并重试', async () => {
  const fake = await startFake({ rejectReasoning: true });
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
catalog:
  sync_enabled: false
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    default_reasoning_effort: medium
    keys:
      - label: good
        key: ok-key
    models:
      - id: think-model
        upstream: upstream-model
        capabilities:
          tools: true
          vision: false
          reasoning: true
`);
  try {
    const response = await chat(harness, {
      model: 'think-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].message.content, 'Hello hi');
    assert.equal(fake.bodies.length, 2);
    assert.equal(fake.bodies[0]?.reasoning_effort, 'medium');
    assert.equal(fake.bodies[1]?.reasoning_effort, undefined);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('同步能力策略：未声明默认放行，strict 模式按不支持拒绝', async () => {
  const fake = await startFake({ models: ['qwen4-max:free'] });

  const permissive = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
catalog:
  sync_enabled: true
  sync_on_start: true
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: placeholder
        capabilities:
          tools: true
          vision: false
          reasoning: false
`);
  try {
    const admin = await adminGet(permissive, '/admin/api/models');
    const synced = admin.models.find((m: any) => m.id === 'qwen4-max:free');
    assert.equal(synced.capabilities.reasoning, true);

    const ok = await chat(permissive, {
      model: 'qwen4-max:free',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    });
    assert.equal(ok.status, 200);
  } finally {
    await permissive.close();
  }

  const strict = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
catalog:
  sync_enabled: true
  sync_on_start: true
  strict_capabilities: true
  reasoning_hints: false
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: placeholder
        capabilities:
          tools: true
          vision: false
          reasoning: false
`);
  try {
    const admin = await adminGet(strict, '/admin/api/models');
    const synced = admin.models.find((m: any) => m.id === 'qwen4-max:free');
    assert.equal(synced.capabilities.reasoning, false);

    const rejected = await chat(strict, {
      model: 'qwen4-max:free',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'capability_mismatch');
  } finally {
    await strict.close();
    await fake.close();
  }
});
