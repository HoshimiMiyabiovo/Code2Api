import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';
import {
  decryptCodeArtsPassword,
  discoverCodeArtsPort,
  resolveCodeArtsEndpoint,
} from '../src/providers/codearts-discovery.js';
import {
  normalizeEvent,
  sanitizeEventFrame,
  sessionIdOfEvent,
} from '../src/providers/opencode-worker.js';

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * CodeArts IDE 内核 fake（v126.11.1 实测契约）：
 * - 旧版 opencode API：路由无 /api 前缀；Basic 用户名 codearts。
 * - GET /config 就绪探针；GET /provider 返回 {all:[{models:{id:entry}}]}。
 * - POST /session?directory= 直接返回会话对象；POST /session/:id/message 入队并触发执行。
 * - GET /session/:id/message 返回 [{info,parts}] 数组；DELETE /session/:id 返回 true。
 * - 事件流 /event 与原版同构（message.part.updated / session.idle）。
 */
class FakeCodeArts {
  private readonly server: Server;
  readonly password = 'fake-codearts-pass';
  baseUrl = '';
  readonly prompts: Array<{ sessionID: string; text: string; model?: any }> = [];
  readonly createdDirectories: Array<string | undefined> = [];
  private readonly sessions = new Map<string, any>();
  private readonly clients = new Set<ServerResponse>();
  private counter = 0;
  private lastReply = '';

  constructor(
    private readonly options: {
      /** SSE 负载形态：properties（v126.11.1）/ data（原版）/ envelope（directory+payload）。 */
      shape?: 'properties' | 'data' | 'envelope';
      /** true = 受理 prompt 后不发任何事件，用于首包超时测试。 */
      silent?: boolean;
    } = {},
  ) {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  port(): number {
    return (this.server.address() as AddressInfo).port;
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

  private emit(type: string, data: Record<string, unknown>): void {
    const shape = this.options.shape ?? 'properties';
    const payload =
      shape === 'data'
        ? { type, data }
        : shape === 'envelope'
          ? { directory: 'C:/fake-workspace', payload: { type, properties: data } }
          : { type, properties: data };
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const expected =
      'Basic ' + Buffer.from(`codearts:${this.password}`).toString('base64');
    return req.headers.authorization === expected;
  }

  private finishTask(sessionID: string, text: string): void {
    this.lastReply = text;
    const assistantId = `msg_asst_${++this.counter}`;
    this.emit('message.updated', {
      sessionID,
      info: {
        id: assistantId,
        role: 'assistant',
        sessionID,
        time: { created: Date.now() },
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    this.emit('message.part.updated', {
      sessionID,
      part: { id: `prt_${this.counter}`, messageID: assistantId, type: 'text', text },
    });
    this.emit('session.idle', { sessionID });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/config') {
      json(200, { $schema: 'https://opencode.ai/config.json', logLevel: 'INFO' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/provider') {
      json(200, {
        all: [
          {
            id: 'inferhub-provider',
            name: 'inferhub-provider',
            models: {
              'fake-chat': {
                id: 'fake-chat',
                providerID: 'inferhub-provider',
                name: 'Fake Chat',
                status: 'active',
                capabilities: {
                  toolcall: true,
                  input: { text: true, image: true, audio: false },
                  output: { text: true },
                },
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: 1048576, output: 65536 },
                variants: {},
              },
              'fake-disabled': {
                id: 'fake-disabled',
                providerID: 'inferhub-provider',
                status: 'disabled',
              },
            },
          },
        ],
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/event') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      this.clients.add(res);
      this.emit('server.connected', {});
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/session') {
      const body = await readJson(req);
      const directory = url.searchParams.get('directory') ?? undefined;
      this.createdDirectories.push(directory);
      const id = `ses_fake_${++this.counter}`;
      const session = {
        id,
        title: body.title ?? 'fake',
        directory: directory ?? 'C:/fake',
        time: { created: Date.now(), updated: Date.now() },
      };
      this.sessions.set(id, session);
      json(200, session);
      return;
    }
    const sessionMatch = /^\/session\/([^/]+)(.*)$/.exec(url.pathname);
    if (sessionMatch) {
      const sessionID = decodeURIComponent(sessionMatch[1] ?? '');
      const rest = sessionMatch[2] ?? '';
      const session = this.sessions.get(sessionID);
      if (!session) {
        json(404, { error: 'session not found' });
        return;
      }
      if (req.method === 'GET' && rest === '') {
        json(200, session);
        return;
      }
      if (req.method === 'DELETE' && rest === '') {
        this.sessions.delete(sessionID);
        json(200, true);
        return;
      }
      if (req.method === 'GET' && rest === '/message') {
        json(200, [
          ...(this.lastReply
            ? [
                {
                  info: {
                    id: 'msg_fake_assistant',
                    role: 'assistant',
                    sessionID,
                    time: { created: Date.now() },
                  },
                  parts: [{ type: 'text', text: this.lastReply }],
                },
              ]
            : []),
        ]);
        return;
      }
      if (req.method === 'POST' && rest === '/message') {
        const body = await readJson(req);
        // 实测契约：{sessionID, model:{providerID,modelID}, parts, agent}
        if (!Array.isArray(body.parts) || typeof body.model?.modelID !== 'string') {
          json(400, { error: 'Missing parts or model.modelID' });
          return;
        }
        const text = body.parts
          .filter((part: any) => part?.type === 'text')
          .map((part: any) => part.text)
          .join('');
        this.prompts.push({ sessionID, text, model: body.model });
        const userId = `msg_user_${++this.counter}`;
        this.emit('message.updated', {
          sessionID,
          info: { id: userId, role: 'user', sessionID, time: { created: Date.now() } },
        });
        json(200, {});
        if (!this.options.silent) {
          setTimeout(() => this.finishTask(sessionID, `fake reply: ${text}`), 20);
        }
        return;
      }
      if (req.method === 'POST' && rest === '/interrupt') {
        json(200, { interrupted: true });
        return;
      }
    }
    json(404, { error: 'not found' });
  }
}

/** 按 IDE 实测格式生成加密口令文件（4/custom-dir/2/3）。 */
function writeEncryptedPassword(dataDir: string, password: string): void {
  const secret = randomBytes(16).toString('hex');
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = scryptSync(secret, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  mkdirSync(join(dataDir, '4'), { recursive: true });
  mkdirSync(join(dataDir, 'custom-dir'), { recursive: true });
  mkdirSync(join(dataDir, '2'), { recursive: true });
  mkdirSync(join(dataDir, '3'), { recursive: true });
  writeFileSync(join(dataDir, '4', 'data'), Buffer.from(secret).toString('base64'));
  writeFileSync(
    join(dataDir, 'custom-dir', 'data'),
    JSON.stringify({
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }),
  );
  writeFileSync(join(dataDir, '2', 'data'), JSON.stringify(salt.toString('base64')));
  writeFileSync(join(dataDir, '3', 'data'), JSON.stringify(iv.toString('base64')));
}

interface Harness {
  base: string;
  adminToken: string;
  gateway: Gateway;
  close: () => Promise<void>;
}

async function startGateway(yaml: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-ca-test-'));
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

/** 为 CodeArts fake 拉起一个网关，extraYaml 追加到 provider 条目下（缩进 4 空格）。 */
async function startCodeArtsGateway(
  fake: FakeCodeArts,
  extraYaml = '',
): Promise<Harness & { root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'c2a-ca-fake-'));
  const dataDir = join(root, 'codearts-data');
  writeEncryptedPassword(dataDir, fake.password);
  const propsDir = join(root, 'CodeArts_Agent', 'Vscode_test');
  mkdirSync(propsDir, { recursive: true });
  writeFileSync(
    join(propsDir, 'server_config.properties'),
    `pid=9999\nport=${fake.port()}\nversion=test\n`,
  );
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-ca
    type: opencode
    flavor: codearts
    codearts_data_dir: ${JSON.stringify(dataDir)}
    priority: 10
    auto_models: true
    models: []
${extraYaml}
`);
  return { ...harness, root };
}

test('codearts 发现：加密口令解密与端口发现', () => {
  const root = mkdtempSync(join(tmpdir(), 'c2a-ca-discovery-'));
  try {
    const dataDir = join(root, 'codearts-data');
    writeEncryptedPassword(dataDir, 'unit-test-secret');
    assert.equal(decryptCodeArtsPassword(dataDir), 'unit-test-secret');
    assert.equal(decryptCodeArtsPassword(join(root, 'missing')), null);

    const propsDir = join(root, 'CodeArts_Agent', 'Vscode_test');
    mkdirSync(propsDir, { recursive: true });
    writeFileSync(
      join(propsDir, 'server_config.properties'),
      '# comment\npid=4321\nport=54431\nversion=test\n',
    );
    const discovered = discoverCodeArtsPort(dataDir);
    assert.deepEqual(discovered, { port: 54431, pid: 4321 });

    const endpoint = resolveCodeArtsEndpoint(dataDir);
    assert.equal(endpoint?.baseUrl, 'http://127.0.0.1:54431');
    assert.equal(endpoint?.password, 'unit-test-secret');
    assert.equal(resolveCodeArtsEndpoint(join(root, 'missing')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codearts 风味：外部模式自动发现 + 任务级对话', async () => {
  const fake = new FakeCodeArts();
  await fake.start();
  const root = mkdtempSync(join(tmpdir(), 'c2a-ca-e2e-'));
  const dataDir = join(root, 'codearts-data');
  writeEncryptedPassword(dataDir, fake.password);
  const propsDir = join(root, 'CodeArts_Agent', 'Vscode_test');
  mkdirSync(propsDir, { recursive: true });
  writeFileSync(
    join(propsDir, 'server_config.properties'),
    `pid=9999\nport=${fake.port()}\nversion=test\n`,
  );
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-ca
    type: opencode
    flavor: codearts
    codearts_data_dir: ${JSON.stringify(dataDir)}
    priority: 10
    auto_models: true
    models: []
`);
  try {
    // 自动发现：/provider 目录映射展开，disabled 过滤，capabilities 布尔映射解析。
    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    const ids = models.data.map((m: any) => m.id);
    assert.ok(ids.includes('fake-chat'));
    assert.ok(!ids.includes('fake-disabled'));

    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-chat',
        messages: [{ role: 'user', content: 'codearts hello' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'fake reply: codearts hello');
    // prompt 走 /message，model 键是 modelID（不是 id）。
    assert.equal(fake.prompts.length, 1);
    assert.deepEqual(fake.prompts[0].model, {
      providerID: 'inferhub-provider',
      modelID: 'fake-chat',
    });

    // 流式请求：codearts 的 {type, properties} 事件必须被归一化，
    // 否则 text_delta/session.idle 全被丢弃，客户端只能干等到超时。
    const streamed = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        model: 'fake-chat',
        stream: true,
        messages: [{ role: 'user', content: 'codearts stream' }],
      }),
    });
    assert.equal(streamed.status, 200);
    const sse = await streamed.text();
    assert.match(sse, /fake reply: codearts stream/);
    assert.match(sse, /\[DONE\]/);
  } finally {
    await harness.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('codearts 风味：IDE 未运行时给出引导错误', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c2a-ca-offline-'));
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-ca-off
    type: opencode
    flavor: codearts
    codearts_data_dir: ${JSON.stringify(join(root, 'missing'))}
    priority: 10
    auto_models: false
    models:
      - id: m1
        upstream: inferhub-provider/m1
`);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm1',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error.message, /CodeArts/);
  } finally {
    await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('event 归一化：data/properties/directory+payload 与多处 sessionID', () => {
  const fromData = normalizeEvent({
    type: 'session.idle',
    data: { sessionID: 'ses_data' },
  });
  assert.equal(fromData?.type, 'session.idle');
  assert.equal(sessionIdOfEvent(fromData!), 'ses_data');

  const fromProperties = normalizeEvent({
    type: 'session.text.delta',
    properties: { sessionID: 'ses_props', delta: 'hi' },
  });
  assert.equal(fromProperties?.data.delta, 'hi');
  assert.equal(sessionIdOfEvent(fromProperties!), 'ses_props');

  // CodeArts IDE 可能再套一层 {directory, payload} 信封。
  const envelope = normalizeEvent({
    directory: 'C:/fake-workspace',
    payload: {
      type: 'message.part.updated',
      properties: {
        part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'x' },
        info: { sessionID: 'ses_envelope' },
      },
    },
  });
  assert.equal(envelope?.type, 'message.part.updated');
  assert.equal(envelope?.data.directory, 'C:/fake-workspace');
  assert.equal(sessionIdOfEvent(envelope!), 'ses_envelope');

  // sessionID 嵌在 part / message / info / 顶层时的提取。
  const nestedPart = normalizeEvent({
    type: 'message.part.updated',
    properties: { part: { sessionID: 'ses_part' } },
  });
  assert.equal(sessionIdOfEvent(nestedPart!), 'ses_part');
  const nestedMessage = normalizeEvent({
    type: 'message.updated',
    properties: { message: { sessionID: 'ses_message' } },
  });
  assert.equal(sessionIdOfEvent(nestedMessage!), 'ses_message');
  const topLevel = normalizeEvent({ type: 'x', sessionID: 'ses_top' });
  assert.equal(sessionIdOfEvent(topLevel!), 'ses_top');

  // 无法识别的负载必须返回 null（上层记 debug 丢弃原因）。
  assert.equal(normalizeEvent({ payload: { foo: 1 } }), null);
  assert.equal(normalizeEvent('not-an-object'), null);
  assert.equal(normalizeEvent(null), null);
});

test('event 原始帧日志：脱敏 + 截断', () => {
  const text = sanitizeEventFrame(
    JSON.stringify({
      type: 'x',
      properties: {
        token: 'secret-token-value',
        password: 'secret-password',
        nested: { authorization: 'Basic dXNlcjpwYXNz' },
        big: 'a'.repeat(400),
      },
    }),
  );
  assert.ok(!text.includes('secret-token-value'));
  assert.ok(!text.includes('secret-password'));
  assert.ok(!text.includes('dXNlcjpwYXNz'));
  assert.match(text, /\*\*\*/);
  assert.ok(text.length <= 1200);
  // 非法 JSON 退回正则脱敏。
  const broken = sanitizeEventFrame('{"password":"abc","token":"def"');
  assert.ok(!broken.includes('abc'));
  assert.ok(!broken.includes('def'));
  assert.match(broken, /\*\*\*/);
});

test('codearts 事件信封：directory+payload + properties 流式对话', async () => {
  const fake = new FakeCodeArts({ shape: 'envelope' });
  await fake.start();
  const harness = await startCodeArtsGateway(fake);
  try {
    const streamed = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        model: 'fake-chat',
        stream: true,
        messages: [{ role: 'user', content: 'envelope hello' }],
      }),
    });
    assert.equal(streamed.status, 200);
    const sse = await streamed.text();
    assert.match(sse, /envelope hello/);
    assert.match(sse, /data: \[DONE\]/);
  } finally {
    await harness.close();
    await fake.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('codearts 首包超时：静默期心跳保活，随后明确报错', async () => {
  const fake = new FakeCodeArts({ silent: true });
  await fake.start();
  const harness = await startCodeArtsGateway(
    fake,
    '    first_byte_timeout_ms: 400\n    stream_heartbeat_ms: 50\n    task_timeout_ms: 30000\n',
  );
  try {
    const started = Date.now();
    const streamed = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        model: 'fake-chat',
        stream: true,
        messages: [{ role: 'user', content: 'silent stream' }],
      }),
    });
    assert.equal(streamed.status, 200);
    const sse = await streamed.text();
    assert.ok(Date.now() - started < 5000, '首包预算生效后不应挂到客户端超时');
    // 静默期间必须有 SSE 注释帧，客户端空闲计时器不会先掐断连接。
    assert.match(sse, /: keepalive/);
    assert.match(sse, /首包等待超时/);
    assert.match(sse, /data: \[DONE\]/);
  } finally {
    await harness.close();
    await fake.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test('codearts 首包超时：非流式请求直接返回 504', async () => {
  const fake = new FakeCodeArts({ silent: true });
  await fake.start();
  const harness = await startCodeArtsGateway(
    fake,
    '    first_byte_timeout_ms: 300\n    stream_heartbeat_ms: 50\n    task_timeout_ms: 30000\n',
  );
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        model: 'fake-chat',
        messages: [{ role: 'user', content: 'silent non-stream' }],
      }),
    });
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.match(body.error.message, /首包等待超时/);
  } finally {
    await harness.close();
    await fake.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
});
