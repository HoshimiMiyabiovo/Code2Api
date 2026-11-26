import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfig, type OpenAIProviderConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';
import { OpenAICompatibleAdapter } from '../src/providers/openai-compatible.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface FakeUpstream {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

interface FakeOptions {
  /** 模拟严格上游：输入消息里出现 reasoning_content 就 400。 */
  rejectReasoningContent?: boolean;
  streamMode?: 'sse' | 'json' | 'truncated' | 'heartbeat-timeout';
  streamContentType?: string;
  heartbeatDataDelayMs?: number;
}

async function startFake(options: FakeOptions = {}): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const raw = req.method === 'POST' ? await readBody(req) : '';
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      // ignore
    }
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });

    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'go-model', object: 'model', context_length: 128000 }],
        }),
      );
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    const model = String(body.model ?? 'unknown');
    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>)
      : [];
    if (options.rejectReasoningContent && messages.some((item) => item.reasoning_content)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'reasoning_content is not allowed on this upstream' },
        }),
      );
      return;
    }
    if (body.stream === true) {
      const send = (data: unknown) => {
        if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      if (options.streamMode === 'json') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          JSON.stringify({
            id: 'fake-json-stream',
            model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Hello JSON' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
        return;
      }
      res.writeHead(200, {
        'content-type': options.streamContentType ?? 'text/event-stream',
      });
      if (options.streamMode === 'truncated') {
        send({
          id: 'fake-stream',
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });
        send({
          id: 'fake-stream',
          model,
          choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
        });
        res.end();
        return;
      }
      if (options.streamMode === 'heartbeat-timeout') {
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(': KILO PROCESSING\n\n');
        }, 20);
        const finish = setTimeout(() => {
          clearInterval(heartbeat);
          send({
            id: 'fake-stream',
            model,
            choices: [{ index: 0, delta: { content: 'too late' }, finish_reason: null }],
          });
          send({
            id: 'fake-stream',
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          });
          if (!res.destroyed) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }, options.heartbeatDataDelayMs ?? 180);
        res.on('close', () => {
          clearInterval(heartbeat);
          clearTimeout(finish);
        });
        return;
      }
      send({
        id: 'fake-stream',
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      send({
        id: 'fake-stream',
        model,
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      });
      send({
        id: 'fake-stream',
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
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
            message: { role: 'assistant', content: 'Hello' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
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
  const dir = mkdtempSync(join(tmpdir(), 'code2api-session-'));
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

function gatewayYaml(
  fake: FakeUpstream,
  providerLines = '',
  idleMs?: number,
  retryEnabled?: boolean,
): string {
  const timeouts =
    idleMs === undefined
      ? ''
      : `    timeouts:
      connect_ms: 5000
      ttfb_ms: 5000
      idle_ms: ${idleMs}
      total_ms: 10000`;
  const retry =
    retryEnabled === undefined
      ? ''
      : `routing:
  retry:
    enabled: ${retryEnabled}`;
  return `
server:
  port: 0
storage:
  path: __DB__
catalog:
  sync_enabled: false
${retry}
providers:
  - id: go
    type: openai-compatible
    base_url: ${fake.baseUrl}/inference/go/openai/v1
    models_url: ${fake.baseUrl}/inference/go/v1/models
    session_header: x-opencode-session
    user_agent: code2api-test/9.9
${providerLines}
${timeouts}
    keys:
      - label: main
        key: test-key
    models:
      - id: go-model
        upstream: go-model
        capabilities:
          reasoning: true
`;
}

async function postChat(
  harness: Harness,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${harness.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function lastChatRequest(fake: FakeUpstream): RecordedRequest {
  const found = [...fake.requests].reverse().find((item) => item.method === 'POST');
  assert.ok(found, 'fake upstream 应收到 chat 请求');
  return found;
}

test('会话头：透传客户端会话 ID，并改写上游 User-Agent', async () => {
  const fake = await startFake();
  const harness = await startGateway(gatewayYaml(fake));
  try {
    const response = await postChat(
      harness,
      { 'x-code2api-session': 'ses_client_1' },
      { model: 'go-model', messages: [{ role: 'user', content: 'hi' }] },
    );
    assert.equal(response.status, 200);
    const first = lastChatRequest(fake);
    assert.equal(first.url, '/inference/go/openai/v1/chat/completions');
    assert.equal(first.headers['x-opencode-session'], 'ses_client_1');
    assert.equal(first.headers['user-agent'], 'code2api-test/9.9');
    assert.equal(first.headers.authorization, 'Bearer test-key');

    // 客户端直接带 Go 的会话头也应透传。
    const streamed = await postChat(
      harness,
      { 'x-opencode-session': 'ses_passthrough' },
      {
        model: 'go-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi again' }],
      },
    );
    assert.equal(streamed.status, 200);
    await streamed.text();
    const second = lastChatRequest(fake);
    assert.equal(second.headers['x-opencode-session'], 'ses_passthrough');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('会话头：客户端未提供时按首条用户消息生成稳定 ID', async () => {
  const fake = await startFake();
  const harness = await startGateway(gatewayYaml(fake));
  try {
    const firstTurn = await postChat(harness, {}, {
      model: 'go-model',
      messages: [
        { role: 'system', content: 'you are a coding agent' },
        { role: 'user', content: 'fix the login bug' },
      ],
    });
    assert.equal(firstTurn.status, 200);

    const secondTurn = await postChat(harness, {}, {
      model: 'go-model',
      messages: [
        { role: 'system', content: 'you are a coding agent' },
        { role: 'user', content: 'fix the login bug' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'now add a test' },
      ],
    });
    assert.equal(secondTurn.status, 200);

    const otherTask = await postChat(harness, {}, {
      model: 'go-model',
      messages: [{ role: 'user', content: 'write a release note' }],
    });
    assert.equal(otherTask.status, 200);

    // Responses 的一次性 ID 不是会话标识，不能直接透传。
    const ephemeral = await postChat(
      harness,
      { 'x-code2api-session': 'resp_should_not_leak' },
      {
        model: 'go-model',
        messages: [{ role: 'user', content: 'fix the login bug' }],
      },
    );
    assert.equal(ephemeral.status, 200);

    const chats = fake.requests.filter((item) => item.method === 'POST');
    const values = chats.map((item) => String(item.headers['x-opencode-session'] ?? ''));
    assert.match(values[0]!, /^ses_[0-9a-f]{32}$/);
    assert.equal(values[1], values[0]);
    assert.notEqual(values[2], values[0]);
    assert.equal(values[3], values[0]);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('思考内容回放：assistant 的 reasoning_content 转发给上游', async () => {
  const fake = await startFake();
  const harness = await startGateway(gatewayYaml(fake));
  try {
    const response = await postChat(harness, {}, {
      model: 'go-model',
      messages: [
        { role: 'user', content: 'think about it' },
        { role: 'assistant', content: 'answer', reasoning_content: 'hidden chain' },
        { role: 'user', content: 'next' },
      ],
    });
    assert.equal(response.status, 200);
    const messages = lastChatRequest(fake).body.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((item) => item.role === 'assistant');
    assert.equal(assistant?.reasoning_content, 'hidden chain');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('思考内容回放：上游拒绝 reasoning_content 时剥离并重试', async () => {
  const fake = await startFake({ rejectReasoningContent: true });
  const harness = await startGateway(gatewayYaml(fake));
  try {
    const response = await postChat(harness, {}, {
      model: 'go-model',
      messages: [
        { role: 'user', content: 'think about it' },
        { role: 'assistant', content: 'answer', reasoning_content: 'hidden chain' },
        { role: 'user', content: 'next' },
      ],
    });
    assert.equal(response.status, 200);
    const chats = fake.requests.filter((item) => item.method === 'POST');
    assert.equal(chats.length, 2);
    const first = (chats[0]!.body.messages as Array<Record<string, unknown>>).find(
      (item) => item.role === 'assistant',
    );
    const second = (chats[1]!.body.messages as Array<Record<string, unknown>>).find(
      (item) => item.role === 'assistant',
    );
    assert.equal(first?.reasoning_content, 'hidden chain');
    assert.equal(second?.reasoning_content, undefined);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('面板渠道 CRUD 往返 models_url / user_agent / session_header', async () => {
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
  - id: mock
    type: mock
    models:
      - id: mock-chat
`);
  const adminHeaders = {
    'content-type': 'application/json',
    authorization: 'Bearer test-admin',
  };
  const basePayload = {
    id: 'go-panel',
    type: 'openai-compatible',
    priority: 5,
    enabled: true,
    baseUrl: `${fake.baseUrl}/inference/go/openai/v1`,
    modelsUrl: `${fake.baseUrl}/inference/go/v1/models`,
    freeOnly: true,
    reasoningField: 'reasoning.effort',
    reasoningOffField: 'reasoning.enabled',
    userAgent: 'panel-test/2.0',
    sessionHeader: 'x-opencode-session',
    authHeader: 'bearer',
    tokenLimitField: 'max_tokens',
    sendStreamOptions: true,
    keys: [{ action: 'new', label: 'main', mode: 'key', key: 'sk-panel-test' }],
    models: [{ id: 'go-model', capabilities: { tools: true, reasoning: true } }],
  };
  try {
    const created = await fetch(`${harness.base}/admin/api/channels`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(basePayload),
    });
    assert.equal(created.status, 200);

    const list = await fetch(`${harness.base}/admin/api/channels`, {
      headers: { authorization: 'Bearer test-admin' },
    }).then((res) => res.json());
    const channel = (list.channels as Array<Record<string, unknown>>).find(
      (item) => item.id === 'go-panel',
    );
    assert.ok(channel);
    assert.equal(channel.modelsUrl, basePayload.modelsUrl);
    assert.equal(channel.freeOnly, true);
    assert.equal(channel.reasoningField, 'reasoning.effort');
    assert.equal(channel.reasoningOffField, 'reasoning.enabled');
    assert.equal(channel.userAgent, basePayload.userAgent);
    assert.equal(channel.sessionHeader, basePayload.sessionHeader);

    // 空字符串表示清空，不能把旧值悄悄保留。
    const cleared = await fetch(`${harness.base}/admin/api/channels/go-panel`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        ...basePayload,
        modelsUrl: '',
        freeOnly: false,
        reasoningField: '',
        reasoningOffField: '',
        userAgent: '',
        sessionHeader: '',
        keys: [{ action: 'keep', label: 'main' }],
      }),
    });
    assert.equal(cleared.status, 200);
    const after = await fetch(`${harness.base}/admin/api/channels`, {
      headers: { authorization: 'Bearer test-admin' },
    }).then((res) => res.json());
    const clearedChannel = (after.channels as Array<Record<string, unknown>>).find(
      (item) => item.id === 'go-panel',
    );
    assert.equal(clearedChannel?.modelsUrl, null);
    assert.equal(clearedChannel?.freeOnly, false);
    assert.equal(clearedChannel?.reasoningField, null);
    assert.equal(clearedChannel?.reasoningOffField, null);
    assert.equal(clearedChannel?.userAgent, null);
    assert.equal(clearedChannel?.sessionHeader, null);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('models_url 覆盖模型目录地址', async () => {
  const fake = await startFake();
  const config = parseConfig({
    providers: [
      {
        id: 'go',
        type: 'openai-compatible',
        base_url: `${fake.baseUrl}/inference/go/openai/v1`,
        models_url: `${fake.baseUrl}/inference/go/v1/models`,
        session_header: 'x-opencode-session',
        models: [{ id: 'go-model' }],
      },
    ],
  });
  try {
    const provider = config.providers[0] as OpenAIProviderConfig;
    const adapter = new OpenAICompatibleAdapter(provider);
    const models = await adapter.listModels(null, 5000);
    assert.deepEqual(
      models.map((item) => item.id),
      ['go-model'],
    );
    const fetched = fake.requests.filter((item) => item.method === 'GET');
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0]!.url, '/inference/go/v1/models');
    assert.match(String(fetched[0]!.headers['x-opencode-session']), /^ses_[0-9a-f]{32}$/);
  } finally {
    await fake.close();
  }
});

test('流式解析：application/json 头但 SSE 体仍正常 replay', async () => {
  const fake = await startFake({ streamContentType: 'application/json' });
  const harness = await startGateway(gatewayYaml(fake));
  try {
    const response = await postChat(harness, {}, {
      model: 'go-model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /Hello/);
    assert.equal(fake.requests.filter((item) => item.method === 'POST').length, 1);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('流式解析：text/event-stream 头但 JSON 完整响应折叠为增量', async () => {
  const fake = await startFake({ streamMode: 'json' });
  const harness = await startGateway(gatewayYaml(fake));
  try {
    const response = await postChat(harness, {}, {
      model: 'go-model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /Hello JSON/);
    assert.equal(fake.requests.filter((item) => item.method === 'POST').length, 1);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('流式截断：已输出内容后无终帧报错且不重放', async () => {
  const fake = await startFake({ streamMode: 'truncated' });
  const harness = await startGateway(gatewayYaml(fake));
  try {
    const response = await postChat(harness, {}, {
      model: 'go-model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /partial/);
    assert.match(text, /terminal frame/);
    assert.equal(fake.requests.filter((item) => item.method === 'POST').length, 1);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('流式心跳：注释帧不重置有效内容空闲计时', async () => {
  const fake = await startFake({ streamMode: 'heartbeat-timeout' });
  const harness = await startGateway(gatewayYaml(fake, '', 100, false));
  try {
    const response = await postChat(harness, {}, {
      model: 'go-model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const body = await response.json();
    assert.equal(response.status, 504);
    assert.match(body.error.message, /idle for \d+ms/);
    assert.equal(fake.requests.filter((item) => item.method === 'POST').length, 1);
  } finally {
    await harness.close();
    await fake.close();
  }
});
