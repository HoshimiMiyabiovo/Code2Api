import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';
import { Store } from '../src/store/db.js';
import { PrivacyGuard, detectSecrets, collectConfigSecrets } from '../src/core/privacy.js';
import type { CanonicalRequest, StreamEvent } from '../src/canonical.js';

const API_KEY = 'sk-test1234567890abcdef';
const CONFIG_SECRET = 'cfg-secret-abcdef123456';

interface Captured {
  bodies: Array<Record<string, any>>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** fake 上游：记录收到的请求体，按最后一条 user / tool 消息内容决定回复。 */
async function startFake(captured: Captured): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const body = JSON.parse(await readBody(req)) as Record<string, any>;
    captured.bodies.push(body);
    const messages: Array<any> = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    const lastTool = [...messages].reverse().find((m) => m?.role === 'tool');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const toolText = typeof lastTool?.content === 'string' ? lastTool.content : '';
    const model = String(body.model ?? 'unknown');

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const delta = (d: Record<string, unknown>, finish: string | null = null) =>
        send({ id: 'up', model, choices: [{ index: 0, delta: d, finish_reason: finish }] });

      if (userText.includes('split-echo')) {
        // 把占位符逐字符拆开回显，验证跨 delta 缓冲还原。
        const match = userText.match(/⟦p:[a-z_]+:[0-9a-f]{8}⟧/);
        const placeholder = match ? match[0] : '⟦p:api_key:deadbeef⟧';
        delta({ role: 'assistant' });
        delta({ content: 'key=' });
        for (const ch of placeholder) delta({ content: ch });
        delta({ content: ' end' });
        delta({}, 'stop');
      } else if (userText.includes('tool-echo')) {
        const match = userText.match(/⟦p:[a-z_]+:[0-9a-f]{8}⟧/);
        const placeholder = match ? match[0] : '⟦p:api_key:deadbeef⟧';
        const args = JSON.stringify({ key: placeholder });
        delta({ role: 'assistant' });
        delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'use_key', arguments: '' } }] });
        // 参数拆成两半，占位符横跨两个 delta
        const mid = Math.floor(args.length / 2);
        delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] });
        delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] });
        delta({}, 'tool_calls');
      } else {
        delta({ role: 'assistant' });
        delta({ content: 'Hello ' });
        delta({ content: userText });
        delta({}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const reply: Record<string, any> = {
      id: 'up',
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello ' + (toolText || userText) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Harness {
  base: string;
  adminToken: string;
  gateway: Gateway;
  configPath: string;
  close: () => Promise<void>;
}

async function startGateway(yaml: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-privacy-'));
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
    configPath,
    close: async () => {
      await gateway.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function channelYaml(fakeBaseUrl: string, privacyBlock: string): string {
  return `
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
${privacyBlock}
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fakeBaseUrl}/v1
    keys:
      - label: good
        key: ${CONFIG_SECRET}
    models:
      - id: test-model
        upstream: upstream-model
`;
}

async function chat(base: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function adminGet(harness: Harness, path: string): Promise<any> {
  const response = await fetch(`${harness.base}${path}`, {
    headers: { authorization: `Bearer ${harness.adminToken}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function adminSend(harness: Harness, path: string, method: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${harness.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${harness.adminToken}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// ---------- 单元：检测 ----------

test('检测：凭据类规则命中且不误伤普通文本', () => {
  const text = [
    'key=' + API_KEY,
    'password: "hunter2-secret"',
    'postgres://admin:s3cret-pass@db.internal:5432/app',
    'Authorization: Bearer abcdef1234567890abcdef',
    'ghp_' + 'a'.repeat(36),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0PTHsuc',
  ].join('\n');
  const findings = detectSecrets(text, { identity: false, configSecrets: [] });
  const categories = findings.map((f) => f.category);
  assert.ok(categories.includes('api_key'));
  assert.ok(categories.includes('assignment'));
  assert.ok(categories.includes('connection'));
  assert.ok(categories.includes('bearer'));
  assert.ok(categories.includes('jwt'));
  assert.ok(findings.some((f) => f.value === API_KEY));
  // 普通文本不应命中
  const clean = detectSecrets('今天天气不错，帮我写一个排序算法', { identity: false, configSecrets: [] });
  assert.equal(clean.length, 0);
});

test('检测：身份类默认关闭，开启后命中邮箱 / 用户目录 / uid', () => {
  const text = 'user alice@example.com lives at C:\\Users\\alice and uid=10086';
  const off = detectSecrets(text, { identity: false, configSecrets: [] });
  assert.equal(off.length, 0);
  const on = detectSecrets(text, { identity: true, configSecrets: [] });
  const categories = on.map((f) => f.category);
  assert.ok(categories.includes('email'));
  assert.ok(categories.includes('identity_path'));
  assert.ok(categories.includes('uid'));
});

test('检测：配置密钥精确匹配零误报', () => {
  const config = parseConfig({
    admin: { token: 'admin-token-xyz789' },
    providers: [
      { id: 'p', type: 'openai-compatible', base_url: 'http://localhost/v1', keys: [{ key: CONFIG_SECRET }], models: [{ id: 'm' }] },
    ],
  });
  const secrets = collectConfigSecrets(config);
  assert.ok(secrets.some((s) => s.value === CONFIG_SECRET));
  const findings = detectSecrets('prefix ' + CONFIG_SECRET + ' suffix', { identity: false, configSecrets: secrets });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'config_secret');
  assert.equal(findings[0].value, CONFIG_SECRET);
});

// ---------- 单元：令牌化 + 还原往返 ----------

function makeGuard(): { guard: PrivacyGuard; store: Store } {
  const store = new Store(':memory:');
  const config = parseConfig({
    privacy: { mode: 'token' },
    providers: [
      { id: 'fake', type: 'openai-compatible', base_url: 'http://localhost/v1', keys: [{ key: CONFIG_SECRET }], models: [{ id: 'm' }] },
    ],
  });
  const guard = new PrivacyGuard({ store, getConfig: () => config, hmacKey: Buffer.alloc(32, 7) });
  return { guard, store };
}

function reqWithText(text: string): CanonicalRequest {
  return { model: 'm', stream: false, messages: [{ role: 'user', parts: [{ type: 'text', text }] }] };
}

test('往返：prepareRequest 替换、restoreResponse 还原，真值加密落库', () => {
  const { guard, store } = makeGuard();
  const original = 'use ' + API_KEY + ' and ' + CONFIG_SECRET;
  const prepared = guard.prepareRequest(reqWithText(original), 'fake', 'openai-compatible');
  const sent = prepared.request.messages[0].parts[0];
  assert.ok(sent.type === 'text');
  if (sent.type !== 'text') return;
  assert.ok(!sent.text.includes(API_KEY));
  assert.ok(!sent.text.includes(CONFIG_SECRET));
  assert.match(sent.text, /⟦p:api_key:[0-9a-f]{8}⟧/);
  assert.match(sent.text, /⟦p:config_secret:[0-9a-f]{8}⟧/);
  assert.equal(prepared.replaced, 2);

  // 保管库：明文不落库
  assert.equal(store.countPrivacyVault(), 2);
  const rows = store.listPrivacyVault(10);
  for (const row of rows) {
    assert.ok(!row.valueEnc.includes(API_KEY));
    assert.ok(row.valueEnc.startsWith('aes1:') || row.valueEnc.startsWith('dpapi:'));
  }

  // 上游回显占位符 → 还原
  const response = guard.restoreResponse(
    { id: 'r', model: 'm', text: sent.text, toolCalls: [], stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    'fake',
  );
  assert.equal(response.text, original);
  store.close();
});

test('往返：占位符对同一真值稳定（prompt cache 友好）', () => {
  const { guard, store } = makeGuard();
  const a = guard.prepareRequest(reqWithText(API_KEY), 'fake', 'openai-compatible');
  const b = guard.prepareRequest(reqWithText('again ' + API_KEY), 'fake', 'openai-compatible');
  const pa = (a.request.messages[0].parts[0] as any).text;
  const pb = (b.request.messages[0].parts[0] as any).text;
  assert.ok(pb.endsWith(pa));
  assert.equal(store.countPrivacyVault(), 1);
  store.close();
});

test('流式：占位符跨任意 delta 拆分仍能还原', async () => {
  const { guard, store } = makeGuard();
  const prepared = guard.prepareRequest(reqWithText(API_KEY), 'fake', 'openai-compatible');
  const placeholder = (prepared.request.messages[0].parts[0] as any).text as string;
  async function* upstream(): AsyncGenerator<StreamEvent, void, void> {
    yield { type: 'text_delta', text: 'key=' };
    for (const ch of placeholder) yield { type: 'text_delta', text: ch };
    yield { type: 'text_delta', text: ' ok' };
    yield { type: 'finish', reason: 'stop' };
  }
  let out = '';
  for await (const event of guard.restoreEvents(upstream(), 'fake')) {
    if (event.type === 'text_delta') out += event.text;
  }
  assert.equal(out, 'key=' + API_KEY + ' ok');
  store.close();
});

test('流式：工具参数聚合后整体还原', async () => {
  const { guard, store } = makeGuard();
  const prepared = guard.prepareRequest(reqWithText(API_KEY), 'fake', 'openai-compatible');
  const placeholder = (prepared.request.messages[0].parts[0] as any).text as string;
  const args = JSON.stringify({ key: placeholder });
  async function* upstream(): AsyncGenerator<StreamEvent, void, void> {
    yield { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'use_key' };
    yield { type: 'tool_call_delta', index: 0, argumentsDelta: args.slice(0, 12) };
    yield { type: 'tool_call_delta', index: 0, argumentsDelta: args.slice(12) };
    yield { type: 'finish', reason: 'tool_calls' };
  }
  let id = '';
  let name = '';
  let argsOut = '';
  for await (const event of guard.restoreEvents(upstream(), 'fake')) {
    if (event.type === 'tool_call_delta') {
      if (event.id) id = event.id;
      if (event.name) name = event.name;
      if (event.argumentsDelta) argsOut += event.argumentsDelta;
    }
  }
  assert.equal(id, 'call_1');
  assert.equal(name, 'use_key');
  assert.equal(argsOut, JSON.stringify({ key: API_KEY }));
  store.close();
});

// ---------- 集成：网关 + fake 上游 ----------

test('集成：token 模式出站替换、入站还原，客户端无感', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, 'privacy:\n  mode: token'));
  try {
    const body = await chat(harness.base, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'echo ' + API_KEY }],
    });
    // 客户端拿回真值
    assert.equal(body.choices[0].message.content, 'Hello echo ' + API_KEY);
    // 上游只见到占位符
    const upstreamBody = captured.bodies[0];
    const upstreamText = upstreamBody.messages[0].content;
    assert.ok(!upstreamText.includes(API_KEY));
    assert.match(upstreamText, /⟦p:api_key:[0-9a-f]{8}⟧/);

    const privacy = await adminGet(harness, '/admin/api/privacy?range=24h');
    assert.equal(privacy.config.mode, 'token');
    assert.equal(privacy.status.mode, 'token');
    assert.ok(privacy.totals.tokenized >= 1);
    assert.ok(privacy.totals.restored >= 1);
    assert.ok(privacy.vault.length >= 1);
    // 面板不泄露真值
    assert.ok(JSON.stringify(privacy).indexOf(API_KEY) < 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('集成：配置密钥精确保护（零误报）', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, 'privacy:\n  mode: token'));
  try {
    const body = await chat(harness.base, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'secret ' + CONFIG_SECRET }],
    });
    assert.equal(body.choices[0].message.content, 'Hello secret ' + CONFIG_SECRET);
    const upstreamText = captured.bodies[0].messages[0].content;
    assert.ok(!upstreamText.includes(CONFIG_SECRET));
    assert.match(upstreamText, /⟦p:config_secret:[0-9a-f]{8}⟧/);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('集成：audit 模式只记录不替换', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, 'privacy:\n  mode: audit'));
  try {
    const body = await chat(harness.base, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'echo ' + API_KEY }],
    });
    assert.equal(body.choices[0].message.content, 'Hello echo ' + API_KEY);
    // audit 不替换：上游仍见真值
    assert.ok(captured.bodies[0].messages[0].content.includes(API_KEY));
    const privacy = await adminGet(harness, '/admin/api/privacy?range=24h');
    assert.ok(privacy.totals.detected >= 1);
    assert.equal(privacy.totals.tokenized, 0);
    assert.equal(privacy.vault.length, 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('集成：off 模式完全透传', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, ''));
  try {
    await chat(harness.base, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'echo ' + API_KEY }],
    });
    assert.ok(captured.bodies[0].messages[0].content.includes(API_KEY));
    const privacy = await adminGet(harness, '/admin/api/privacy?range=24h');
    assert.equal(privacy.status.mode, 'off');
    assert.equal(privacy.totals.detected, 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('集成：流式占位符逐字符拆分回显仍还原', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, 'privacy:\n  mode: token'));
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'split-echo ' + API_KEY }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    // 拼接所有 content delta
    let content = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      const chunk = JSON.parse(line.slice(6));
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) content += delta;
    }
    assert.equal(content, 'key=' + API_KEY + ' end');
    assert.ok(!text.includes('⟦p:'));
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('集成：流式工具参数占位符还原', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, 'privacy:\n  mode: token'));
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'tool-echo ' + API_KEY }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    let args = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      const chunk = JSON.parse(line.slice(6));
      const calls = chunk.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (call.function?.arguments) args += call.function.arguments;
        }
      }
    }
    assert.equal(args, JSON.stringify({ key: API_KEY }));
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('集成：tool_result 里的密钥同样被令牌化', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, 'privacy:\n  mode: token'));
  try {
    const body = await chat(harness.base, {
      model: 'test-model',
      messages: [
        { role: 'user', content: 'read the file' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contains ' + API_KEY },
      ],
    });
    assert.equal(body.choices[0].message.content, 'Hello file contains ' + API_KEY);
    const toolMsg = captured.bodies[0].messages.find((m: any) => m.role === 'tool');
    assert.ok(!toolMsg.content.includes(API_KEY));
    assert.match(toolMsg.content, /⟦p:api_key:[0-9a-f]{8}⟧/);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('集成：exclude 渠道不生效', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, 'privacy:\n  mode: token\n  providers:\n    exclude: [fake]'));
  try {
    await chat(harness.base, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'echo ' + API_KEY }],
    });
    assert.ok(captured.bodies[0].messages[0].content.includes(API_KEY));
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('集成：面板保存隐私设置并热加载', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, ''));
  try {
    const saved = await adminSend(harness, '/admin/api/privacy', 'PUT', {
      mode: 'token',
      identity: false,
      protectConfigSecrets: true,
      providers: { include: [], exclude: [] },
      tokenRetentionDays: 30,
      maxVaultEntries: 5000,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ok, true);
    // 热加载后立即生效
    await chat(harness.base, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'echo ' + API_KEY }],
    });
    assert.ok(!captured.bodies[0].messages[0].content.includes(API_KEY));
    const privacy = await adminGet(harness, '/admin/api/privacy?range=24h');
    assert.equal(privacy.config.mode, 'token');
    assert.equal(privacy.editable, true);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('集成：未鉴权访问隐私 API 返回 401', async () => {
  const captured: Captured = { bodies: [] };
  const fake = await startFake(captured);
  const harness = await startGateway(channelYaml(fake.baseUrl, 'privacy:\n  mode: token'));
  try {
    const response = await fetch(`${harness.base}/admin/api/privacy`);
    assert.equal(response.status, 401);
  } finally {
    await harness.close();
    await fake.close();
  }
});
