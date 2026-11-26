import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

interface FakeUpstream {
  baseUrl: string;
  close: () => Promise<void>;
}

interface FakeOptions {
  rejectStreamOptions?: boolean;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

async function startFakeUpstream(options: FakeOptions = {}): Promise<FakeUpstream> {
  const server: Server = createServer(async (req, res) => {
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
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const key = auth.replace(/^Bearer\s+/i, '');
    if (key === 'bad-key') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
      return;
    }
    if (key === 'limit-key') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    if (options.rejectStreamOptions && body.stream_options) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown field stream_options' } }));
      return;
    }

    const model = String(body.model ?? 'unknown');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m: any) => m?.role === 'user');
    const userText =
      lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';

    if (model === 'upstream-parallel-tool-model' && body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ id: 'up-par', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      send({
        id: 'up-par',
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_p1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      send({
        id: 'up-par',
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: 'call_p2',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      send({
        id: 'up-par',
        model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] },
            finish_reason: null,
          },
        ],
      });
      send({
        id: 'up-par',
        model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: '"上海"}' } }] },
            finish_reason: null,
          },
        ],
      });
      send({ id: 'up-par', model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (model === 'upstream-tool-model') {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        send({ id: 'up-tool', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        send({
          id: 'up-tool',
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_stream_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          id: 'up-tool',
          model,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"' } }] },
              finish_reason: null,
            },
          ],
        });
        send({
          id: 'up-tool',
          model,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '上海"}' } }] },
              finish_reason: null,
            },
          ],
        });
        send({
          id: 'up-tool',
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'up-tool',
          object: 'chat.completion',
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"上海"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
      );
      return;
    }

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ id: 'up-stream', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      send({ id: 'up-stream', model, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] });
      send({ id: 'up-stream', model, choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] });
      send({ id: 'up-stream', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      const streamOptions = body.stream_options as Record<string, unknown> | undefined;
      if (streamOptions?.include_usage) {
        send({
          id: 'up-stream',
          model,
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'up-1',
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
  configPath: string;
  close: () => Promise<void>;
}

async function startGateway(yaml: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-test-'));
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

async function adminGet(harness: Harness, path: string): Promise<any> {
  const response = await fetch(`${harness.base}${path}`, {
    headers: { authorization: `Bearer ${harness.adminToken}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function adminSend(
  harness: Harness,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${harness.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${harness.adminToken}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

test('mock 渠道：模型列表、对话、管理面板与鉴权', async () => {
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: mock
    type: mock
    models:
      - id: mock-chat
        pricing:
          input_per_mtok: 1
          output_per_mtok: 2
`);
  try {
    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    assert.equal(models.data.length, 1);
    assert.equal(models.data[0].id, 'mock-chat');

    const chatResponse = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-chat',
        messages: [{ role: 'user', content: '你好' }],
      }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.match(chat.choices[0].message.content, /你好/);

    const overview = await adminGet(harness, '/admin/api/overview?range=24h');
    assert.equal(overview.providers[0].id, 'mock');
    assert.equal(overview.providers[0].keys[0].label, 'no-auth');
    assert.ok(overview.totals.requests >= 1);
    assert.ok(overview.totals.inputTokens > 0);
    assert.ok(overview.totals.costUsd > 0);

    const unauth = await fetch(`${harness.base}/admin/api/overview`);
    assert.equal(unauth.status, 401);

    const page = await fetch(`${harness.base}/admin`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Code2Api 控制台/);
  } finally {
    await harness.close();
  }
});

test('跨渠道故障转移与密钥冷却', async () => {
  const fake = await startFakeUpstream();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-a
    type: openai-compatible
    priority: 10
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: bad
        key: bad-key
    models:
      - id: shared-model
        upstream: upstream-model
  - id: fake-b
    type: openai-compatible
    priority: 20
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: shared-model
        upstream: upstream-model
`);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'shared-model',
        messages: [{ role: 'user', content: 'failover' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'Hello failover');

    const overview = await adminGet(harness, '/admin/api/overview?range=24h');
    const providerA = overview.providers.find((p: any) => p.id === 'fake-a');
    const providerB = overview.providers.find((p: any) => p.id === 'fake-b');
    assert.equal(providerA.keys[0].status, 'cooling');
    assert.ok(providerA.keys[0].cooldownRemainingMs > 0);
    assert.equal(providerA.stats.requests, 0);
    assert.equal(providerA.stats.errors, 1);
    assert.equal(providerB.stats.requests, 1);
    assert.equal(providerB.stats.errors, 0);

    const requests = await adminGet(harness, '/admin/api/requests?range=24h&limit=10');
    assert.equal(requests.requests[0].provider, 'fake-b');
    assert.equal(requests.requests[0].status, 'ok');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('一键清空冷却：admin API 解除密钥冷却并恢复路由', async () => {
  const fake = await startFakeUpstream();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-a
    type: openai-compatible
    priority: 10
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: bad
        key: bad-key
    models:
      - id: shared-model
        upstream: upstream-model
  - id: fake-b
    type: openai-compatible
    priority: 20
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: shared-model
        upstream: upstream-model
`);
  try {
    const chat = () =>
      fetch(`${harness.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'shared-model',
          messages: [{ role: 'user', content: 'clear-cooldown' }],
        }),
      });

    // 第一次请求：fake-a 密钥被打入冷却，请求 failover 到 fake-b
    const first = await chat();
    assert.equal(first.status, 200);
    let overview = await adminGet(harness, '/admin/api/overview?range=24h');
    let providerA = overview.providers.find((p: any) => p.id === 'fake-a');
    assert.equal(providerA.keys[0].status, 'cooling');
    assert.ok(providerA.keys[0].cooldownRemainingMs > 0);

    // 未授权访问被拒绝
    const unauth = await fetch(`${harness.base}/admin/api/maintenance/clear-cooldowns`, {
      method: 'POST',
    });
    assert.equal(unauth.status, 401);

    // 清空冷却：只有 fake-a 的密钥处于冷却中
    const cleared = await adminSend(harness, '/admin/api/maintenance/clear-cooldowns', 'POST');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.cleared, 1);

    overview = await adminGet(harness, '/admin/api/overview?range=24h');
    providerA = overview.providers.find((p: any) => p.id === 'fake-a');
    assert.equal(providerA.keys[0].status, 'ready');
    assert.equal(providerA.keys[0].cooldownRemainingMs, 0);

    // 没有冷却可清时返回 0
    const again = await adminSend(harness, '/admin/api/maintenance/clear-cooldowns', 'POST');
    assert.equal(again.status, 200);
    assert.equal(again.body.cleared, 0);

    // 清空后 fake-a 重新参与路由：仍失败但错误计数增加（证明不再被跳过）
    const second = await chat();
    assert.equal(second.status, 200);
    overview = await adminGet(harness, '/admin/api/overview?range=24h');
    providerA = overview.providers.find((p: any) => p.id === 'fake-a');
    const providerB = overview.providers.find((p: any) => p.id === 'fake-b');
    assert.equal(providerA.stats.errors, 2);
    assert.equal(providerB.stats.requests, 2);
    assert.equal(providerA.keys[0].status, 'cooling');

    const latest = await adminGet(harness, '/admin/api/requests?range=24h&limit=10');
    assert.equal(latest.requests[0].provider, 'fake-b');
    assert.equal(latest.requests[0].status, 'ok');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('流式：上游拒绝 stream_options 时自动降级重试', async () => {
  const fake = await startFakeUpstream({ rejectStreamOptions: true });
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: test-model
        upstream: upstream-model
`);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'stream' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"Hello"/);
    assert.match(text, /"content":" world"/);
    assert.match(text, /data: \[DONE\]/);

    const overview = await adminGet(harness, '/admin/api/overview?range=24h');
    assert.equal(overview.totals.requests, 1);
    assert.equal(overview.totals.errors, 0);
    assert.equal(overview.totals.ok, 1);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('流式：include_usage 上游用量回传与统计', async () => {
  const fake = await startFakeUpstream();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: test-model
        upstream: upstream-model
        pricing:
          input_per_mtok: 1
          output_per_mtok: 2
`);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'usage' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"usage":\{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13\}/);

    const requests = await adminGet(harness, '/admin/api/requests?range=24h');
    assert.equal(requests.requests[0].inputTokens, 11);
    assert.equal(requests.requests[0].outputTokens, 2);
    assert.equal(requests.requests[0].estimated, false);
    assert.ok(requests.requests[0].ttfbMs !== null);
    assert.ok(requests.requests[0].costUsd > 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('Anthropic：工具调用非流式与流式事件', async () => {
  const fake = await startFakeUpstream();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: claude-test
        upstream: upstream-tool-model
      - id: claude-parallel
        upstream: upstream-parallel-tool-model
`);
  try {
    const response = await fetch(`${harness.base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-test',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '天气如何' },
              {
                type: 'tool_result',
                tool_use_id: 'call_prev',
                content: 'previous',
              },
            ],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            description: '查询天气',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.type, 'message');
    assert.equal(body.stop_reason, 'tool_use');
    const toolUse = body.content.find((block: any) => block.type === 'tool_use');
    assert.ok(toolUse);
    assert.equal(toolUse.name, 'get_weather');
    assert.deepEqual(toolUse.input, { city: '上海' });

    const streamResponse = await fetch(`${harness.base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-test',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: '天气如何' }],
      }),
    });
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    assert.match(streamText, /event: message_start/);
    assert.match(streamText, /"type":"tool_use"/);
    assert.match(streamText, /input_json_delta/);
    assert.match(streamText, /event: message_stop/);
    assert.match(streamText, /"stop_reason":"tool_use"/);

    const parallelResponse = await fetch(`${harness.base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-parallel',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: '两地天气' }],
      }),
    });
    assert.equal(parallelResponse.status, 200);
    const parallelText = await parallelResponse.text();
    assert.match(parallelText, /call_p1/);
    assert.match(parallelText, /call_p2/);
    assert.match(parallelText, /北京/);
    assert.match(parallelText, /上海/);
    assert.match(parallelText, /"stop_reason":"tool_use"/);
    const blockStarts = parallelText.match(/event: content_block_start/g) ?? [];
    assert.equal(blockStarts.length, 2);
    const deltas = parallelText.match(/input_json_delta/g) ?? [];
    assert.equal(deltas.length, 2);

    const countResponse = await fetch(`${harness.base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-test',
        messages: [{ role: 'user', content: '统计一下这段文本' }],
      }),
    });
    assert.equal(countResponse.status, 200);
    const count = await countResponse.json();
    assert.ok(count.input_tokens > 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('OpenAI 工具调用流式转译', async () => {
  const fake = await startFakeUpstream();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: good
        key: ok-key
    models:
      - id: tool-model
        upstream: upstream-tool-model
`);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tool-model',
        stream: true,
        messages: [{ role: 'user', content: 'weather' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"tool_calls"/);
    assert.match(text, /"name":"get_weather"/);
    assert.match(text, /city/);
    assert.match(text, /上海/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('网关客户端鉴权：OpenAI 与 Anthropic 错误格式', async () => {
  const harness = await startGateway(`
server:
  port: 0
  client_keys:
    - gw-secret
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: mock
    type: mock
    models:
      - id: mock-chat
`);
  try {
    const denied = await fetch(`${harness.base}/v1/models`);
    assert.equal(denied.status, 401);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.error.type, 'authentication_error');

    const anthropicDenied = await fetch(`${harness.base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-chat',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(anthropicDenied.status, 401);
    const anthropicBody = await anthropicDenied.json();
    assert.equal(anthropicBody.type, 'error');
    assert.equal(anthropicBody.error.type, 'authentication_error');

    const allowed = await fetch(`${harness.base}/v1/models`, {
      headers: { 'x-api-key': 'gw-secret' },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await harness.close();
  }
});

test('管理面板渠道 CRUD：新增、热加载、保留密钥、删除', async () => {
  const fake = await startFakeUpstream();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: mock
    type: mock
    models:
      - id: mock-chat
`);
  try {
    const createPayload = {
      id: 'admin-station',
      type: 'openai-compatible',
      priority: 5,
      enabled: true,
      baseUrl: `${fake.baseUrl}/v1/`,
      authHeader: 'bearer',
      tokenLimitField: 'max_tokens',
      sendStreamOptions: true,
      keys: [
        { action: 'new', label: 'main', mode: 'key', key: 'sk-test-secret-9876' },
      ],
      models: [
        {
          id: 'admin-model',
          upstream: 'upstream-model',
          contextWindow: 128000,
          maxOutputTokens: 8192,
          capabilities: { tools: true, vision: false, reasoning: true },
          pricing: { inputPerMtok: 1, outputPerMtok: 2 },
        },
      ],
    };

    const created = await adminSend(harness, '/admin/api/channels', 'POST', createPayload);
    assert.equal(created.status, 200);
    assert.deepEqual(created.body.warnings, []);

    const saved = loadConfig(harness.configPath);
    assert.equal(saved.admin.token, 'test-admin');
    const savedProvider = saved.providers.find((p) => p.id === 'admin-station');
    assert.ok(savedProvider && savedProvider.type === 'openai-compatible');
    if (savedProvider.type === 'openai-compatible') {
      assert.equal(savedProvider.keys[0]?.key, 'sk-test-secret-9876');
      assert.equal(savedProvider.baseUrl, `${fake.baseUrl}/v1`);
      assert.equal(savedProvider.timeouts.ttfbMs, 60000);
    }

    const channels = await adminGet(harness, '/admin/api/channels');
    assert.equal(channels.editable, true);
    assert.ok(!JSON.stringify(channels).includes('sk-test-secret-9876'));
    const listed = channels.channels.find((c: any) => c.id === 'admin-station');
    assert.equal(listed.keys[0].hasKey, true);
    assert.equal(listed.keys[0].masked, 'sk-...9876');

    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    assert.ok(models.data.some((m: any) => m.id === 'admin-model'));

    const chatResponse = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'admin-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(chat.choices[0].message.content, 'Hello hi');

    const updatePayload = {
      ...createPayload,
      priority: 1,
      keys: [{ action: 'keep', label: 'main' }],
      models: [
        {
          ...createPayload.models[0],
          contextWindow: 64000,
        },
      ],
    };
    const updated = await adminSend(
      harness,
      '/admin/api/channels/admin-station',
      'PUT',
      updatePayload,
    );
    assert.equal(updated.status, 200);
    const afterUpdate = loadConfig(harness.configPath);
    const updatedProvider = afterUpdate.providers.find((p) => p.id === 'admin-station');
    assert.ok(updatedProvider && updatedProvider.type === 'openai-compatible');
    if (updatedProvider.type === 'openai-compatible') {
      assert.equal(updatedProvider.priority, 1);
      assert.equal(updatedProvider.keys[0]?.key, 'sk-test-secret-9876');
      assert.equal(updatedProvider.models[0]?.contextWindow, 64000);
    }
    const channelsAfter = await adminGet(harness, '/admin/api/channels');
    assert.ok(!JSON.stringify(channelsAfter).includes('sk-test-secret-9876'));

    const missingEnvName = 'CODE2API_TEST_MISSING_ENV_9876';
    delete process.env[missingEnvName];
    const envCreated = await adminSend(harness, '/admin/api/channels', 'POST', {
      ...createPayload,
      id: 'env-station',
      keys: [{ action: 'new', label: 'main', mode: 'env', keyEnv: missingEnvName }],
      models: [{ id: 'env-model' }],
    });
    assert.equal(envCreated.status, 200);
    assert.ok(envCreated.body.warnings.some((w: string) => w.includes(missingEnvName)));
    const channelsWithEnv = await adminGet(harness, '/admin/api/channels');
    const envProvider = channelsWithEnv.channels.find((c: any) => c.id === 'env-station');
    assert.match(envProvider.disabledReason, /环境变量/);
    assert.equal(envProvider.keys[0].status, 'missing_env');

    const envDeleted = await adminSend(harness, '/admin/api/channels/env-station', 'DELETE');
    assert.equal(envDeleted.status, 200);

    const deleted = await adminSend(harness, '/admin/api/channels/admin-station', 'DELETE');
    assert.equal(deleted.status, 200);
    const modelsAfter = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    assert.ok(!modelsAfter.data.some((m: any) => m.id === 'admin-model'));
    const chatAfter = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'admin-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(chatAfter.status, 404);

    const deleteMock = await adminSend(harness, '/admin/api/channels/mock', 'DELETE');
    assert.equal(deleteMock.status, 400);
    assert.match(deleteMock.body.error.message, /至少保留一个渠道/);

    const finalConfig = loadConfig(harness.configPath);
    assert.equal(finalConfig.admin.token, 'test-admin');
    assert.deepEqual(finalConfig.providers.map((p) => p.id), ['mock']);
  } finally {
    await harness.close();
    await fake.close();
  }
});
