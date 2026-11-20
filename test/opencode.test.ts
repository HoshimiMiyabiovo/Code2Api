import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

type Mode = 'normal' | 'question' | 'permission';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeOpenCode {
  private readonly server: Server;
  readonly password = 'fake-opencode-pass';
  baseUrl = '';
  mode: Mode = 'normal';
  readonly prompts: Array<{ sessionID: string; text: string }> = [];
  readonly decisions: string[] = [];
  readonly answers: unknown[] = [];
  readonly createdLocations: Array<string | undefined> = [];
  private readonly sessions = new Map<string, any>();
  private readonly clients = new Set<ServerResponse>();
  private counter = 0;
  private lastText = '';
  private lastReply = '';
  private assistantId = 'msg_fake_assistant';
  private questionSession = '';
  private permissionSession = '';

  constructor() {
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

  private emit(type: string, data: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({
      id: `evt_${++this.counter}`,
      created: Date.now(),
      type,
      data,
    })}\n\n`;
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
      'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64');
    return req.headers.authorization === expected;
  }

  private createSession(title: string, model: any, directory?: string): any {
    const id = `ses_fake_${++this.counter}`;
    const session = {
      id,
      projectID: 'fake-project',
      title,
      model: model ?? { id: 'fake-model', providerID: 'fake' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), updated: Date.now() },
      location: { directory: directory ?? 'C:/fake' },
    };
    this.sessions.set(id, session);
    return session;
  }

  private finishTask(sessionID: string, assistantMessageID: string, text: string): void {
    this.lastReply = text;
    this.emit('session.text.started', {
      sessionID,
      assistantMessageID,
      ordinal: 0,
    });
    this.emit('session.text.delta', {
      sessionID,
      assistantMessageID,
      ordinal: 0,
      delta: text,
    });
    this.emit('session.text.ended', {
      sessionID,
      assistantMessageID,
      ordinal: 0,
      text,
    });
    this.emit('session.step.ended', {
      sessionID,
      assistantMessageID,
      finish: 'stop',
      rawFinish: 'stop',
      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
      cost: 0,
    });
    this.emit('session.usage.updated', {
      sessionID,
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
    });
    this.emit('session.execution.succeeded', { sessionID });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404);
      res.end();
      return;
    }
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

    if (req.method === 'GET' && url.pathname === '/api/model') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
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
            },
            {
              id: 'fake-image',
              modelID: 'fake-image',
              providerID: 'fake',
              type: 'image',
              enabled: true,
              status: 'active',
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/event') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      this.clients.add(res);
      this.emit('server.connected', {});
      req.on('close', () => this.clients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      const body = await readJson(req);
      this.createdLocations.push(body.location?.directory);
      const session = this.createSession(
        body.title ?? 'fake',
        body.model,
        body.location?.directory,
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: session }));
      return;
    }

    const sessionMatch = /^\/api\/session\/([^/]+)(.*)$/.exec(url.pathname);
    if (sessionMatch) {
      const sessionID = decodeURIComponent(sessionMatch[1] ?? '');
      const rest = sessionMatch[2] ?? '';
      const session = this.sessions.get(sessionID);
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'session not found' } }));
        return;
      }

      if (req.method === 'GET' && rest === '') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: session }));
        return;
      }
      if (req.method === 'POST' && rest === '/model') {
        const body = await readJson(req);
        session.model = body.model;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: session }));
        return;
      }
      if (req.method === 'DELETE' && rest === '') {
        this.sessions.delete(sessionID);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (req.method === 'GET' && rest === '/message') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'msg_fake_user',
                type: 'user',
                text: this.lastText,
                time: { created: Date.now() - 1000 },
              },
              ...(this.lastReply
                ? [
                    {
                      id: this.assistantId,
                      type: 'assistant',
                      time: { created: Date.now() },
                      content: [{ type: 'text', text: this.lastReply }],
                      finish: 'stop',
                      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
                    },
                  ]
                : []),
            ],
            cursor: {},
          }),
        );
        return;
      }
      if (req.method === 'POST' && rest === '/prompt') {
        const body = await readJson(req);
        const text = String(body.text ?? '');
        this.lastText = text;
        this.prompts.push({ sessionID, text });
        const assistantMessageID = `msg_asst_${++this.counter}`;
        this.assistantId = assistantMessageID;
        this.emit('session.inbox.enqueued', { sessionID, inboxID: `msg_${this.counter}` });
        this.emit('session.execution.started', { sessionID });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: {
              id: `msg_${this.counter}`,
              sessionID,
              type: 'user',
              payload: { text },
              delivery: 'steer',
              time: { created: Date.now() },
            },
          }),
        );
        setTimeout(() => {
          if (this.mode === 'question') {
            this.questionSession = sessionID;
            this.emit('form.created', {
              sessionID,
              form: {
                id: 'frm_fake_1',
                sessionID,
                title: '确认',
                fields: [
                  {
                    key: 'q0',
                    title: '是否继续',
                    type: 'string',
                    options: [{ value: '继续', label: '继续' }],
                    custom: true,
                  },
                ],
              },
            });
            return;
          }
          if (this.mode === 'permission') {
            this.permissionSession = sessionID;
            this.emit('permission.asked', {
              id: 'per_fake_1',
              sessionID,
              action: 'read',
              resources: ['*.env'],
            });
            return;
          }
          this.emit('session.tool.called', {
            sessionID,
            assistantMessageID,
            id: 'tool_fake_1',
            name: 'shell',
            input: { command: 'echo fake' },
            executed: false,
          });
          this.emit('session.tool.success', {
            sessionID,
            assistantMessageID,
            id: 'tool_fake_1',
            content: [{ type: 'text', text: 'fake' }],
            executed: false,
          });
          this.finishTask(sessionID, assistantMessageID, `fake reply: ${text}`);
        }, 20);
        return;
      }
      if (req.method === 'POST' && rest.startsWith('/form/') && rest.endsWith('/reply')) {
        const body = await readJson(req);
        this.answers.push(body.answer);
        this.emit('form.replied', {
          sessionID,
          id: 'frm_fake_1',
          answer: body.answer,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        this.finishTask(sessionID, 'msg_after_answer', 'fake reply after answer');
        return;
      }
      if (
        req.method === 'POST' &&
        rest.startsWith('/permission/') &&
        rest.endsWith('/reply')
      ) {
        const body = await readJson(req);
        this.decisions.push(String(body.decision));
        this.emit('permission.replied', {
          sessionID,
          requestID: 'per_fake_1',
          reply: body.decision,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        this.finishTask(sessionID, 'msg_after_permission', 'permission handled');
        return;
      }
      if (req.method === 'POST' && rest === '/interrupt') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ interrupted: true }));
        return;
      }
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

async function startGateway(yaml: string, password: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-oc-test-'));
  const dbPath = join(dir, 'gateway.db').replaceAll('\\', '/');
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, yaml.replaceAll('__DB__', dbPath), 'utf8');
  const config = loadConfig(configPath);
  process.env.C2A_TEST_OC_PASSWORD = password;
  const gateway = await createGateway(config, { configPath });
  await gateway.app.listen({ host: '127.0.0.1', port: 0 });
  const address = gateway.app.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    adminToken: gateway.ctx.adminToken,
    gateway,
    close: async () => {
      await gateway.shutdown();
      delete process.env.C2A_TEST_OC_PASSWORD;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function configYaml(
  fake: FakeOpenCode,
  permissionMode: 'ask' | 'allow',
  workspaceRoots: string[] = [],
): string {
  const rootsYaml =
    workspaceRoots.length > 0
      ? `    workspace_roots:\n${workspaceRoots.map((root) => `      - ${JSON.stringify(root)}`).join('\n')}\n`
      : '';
  return `
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-oc
    type: opencode
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    agent: build
    permission_mode: ${permissionMode}
${rootsYaml}    question_timeout_ms: 60000
    task_timeout_ms: 120000
    models:
      - id: oc-test
        upstream: fake/fake-model
        context_window: 100000
        max_output_tokens: 8192
        capabilities:
          tools: true
          vision: false
          reasoning: true
`;
}

async function adminGet(harness: Harness, path: string): Promise<any> {
  const response = await fetch(`${harness.base}${path}`, {
    headers: { authorization: `Bearer ${harness.adminToken}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('opencode 任务级：非流式、流式与增量去重', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  const harness = await startGateway(configYaml(fake, 'allow'), fake.password);
  try {
    const first = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-session-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        messages: [{ role: 'user', content: 'hello-1' }],
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.choices[0].message.content, 'fake reply: hello-1');

    const second = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-session-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'user', content: 'hello-1' },
          { role: 'assistant', content: 'fake reply: hello-1' },
          { role: 'user', content: 'hello-2' },
        ],
      }),
    });
    assert.equal(second.status, 200);
    const sse = await second.text();
    assert.match(sse, /fake reply: hello-2/);
    assert.match(sse, /data: \[DONE\]/);
    assert.match(sse, /"usage":\{"prompt_tokens":10,"completion_tokens":5/);
    assert.deepEqual(
      fake.prompts.map((p) => p.text),
      ['hello-1', 'hello-2'],
    );

    const requests = await adminGet(harness, '/admin/api/requests?range=all&limit=10');
    assert.equal(requests.requests[0].provider, 'fake-oc');
    assert.equal(requests.requests[0].inputTokens, 10);
    assert.equal(requests.requests[0].outputTokens, 5);
    assert.equal(requests.requests[0].estimated, false);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 提问挂起：面板回答后继续执行', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  fake.mode = 'question';
  const harness = await startGateway(configYaml(fake, 'allow'), fake.password);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-question-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'please ask' }],
      }),
    });
    assert.equal(response.status, 200);
    const bodyPromise = response.text();

    let questions: any[] = [];
    for (let i = 0; i < 50; i += 1) {
      const data = await adminGet(harness, '/admin/api/questions');
      questions = data.questions;
      if (questions.length > 0) break;
      await sleep(100);
    }
    assert.equal(questions.length, 1);
    assert.equal(questions[0].kind, 'form');
    assert.equal(questions[0].payload.title, '确认');

    const answer = await fetch(
      `${harness.base}/admin/api/questions/${questions[0].id}/answer`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ answer: { q0: '继续' } }),
      },
    );
    assert.equal(answer.status, 200);
    const sse = await bodyPromise;
    assert.match(sse, /需要你的确认/);
    assert.match(sse, /fake reply after answer/);
    assert.match(sse, /data: \[DONE\]/);
    assert.deepEqual(fake.answers, [{ q0: '继续' }]);
    const pending = await adminGet(harness, '/admin/api/questions');
    assert.equal(pending.questions.length, 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 审批自动允许', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  fake.mode = 'permission';
  const harness = await startGateway(configYaml(fake, 'allow'), fake.password);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-perm-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        messages: [{ role: 'user', content: 'need permission' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'permission handled');
    assert.deepEqual(fake.decisions, ['once']);
    const questions = await adminGet(harness, '/admin/api/questions');
    assert.equal(questions.questions.length, 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 自动发现模型：无需手填 models', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: auto-oc
    type: opencode
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    auto_models: true
    models: []
`, fake.password);
  try {
    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    const ids = models.data.map((m: any) => m.id);
    assert.ok(ids.includes('auto-model'));
    assert.ok(!ids.includes('fake-image'));

    const admin = await adminGet(harness, '/admin/api/models');
    const auto = admin.models.find((m: any) => m.id === 'auto-model');
    assert.ok(auto);
    assert.equal(auto.source, 'upstream');
    assert.equal(auto.contextWindow, 100000);
    assert.equal(auto.capabilities.vision, true);

    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'auto-model',
        messages: [{ role: 'user', content: 'auto' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'fake reply: auto');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 请求级工作区：白名单校验、创建与切换', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  const root = mkdtempSync(join(tmpdir(), 'c2a-ws-root-'));
  const wsA = join(root, 'proj-a');
  const wsB = join(root, 'proj-b');
  mkdirSync(wsA);
  mkdirSync(wsB);
  const outside = mkdtempSync(join(tmpdir(), 'c2a-ws-out-'));
  const harness = await startGateway(configYaml(fake, 'allow', [root]), fake.password);
  const send = (sessionId: string, workspace?: string) =>
    fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': sessionId,
        ...(workspace ? { 'x-code2api-workspace': workspace } : {}),
      },
      body: JSON.stringify({
        model: 'oc-test',
        messages: [{ role: 'user', content: 'ws' }],
      }),
    });
  try {
    const first = await send('oc-workspace-1', wsA);
    assert.equal(first.status, 200);
    assert.equal(fake.createdLocations.at(-1), realpathSync.native(wsA));

    const sameAgain = await send('oc-workspace-1', wsA);
    assert.equal(sameAgain.status, 200);
    assert.equal(fake.createdLocations.length, 1);

    const switched = await send('oc-workspace-1', wsB);
    assert.equal(switched.status, 400);
    const switchedBody = await switched.json();
    assert.match(switchedBody.error.message, /该会话已绑定工作区/);

    const denied = await send('oc-workspace-1', outside);
    assert.equal(denied.status, 400);
    const deniedBody = await denied.json();
    assert.match(deniedBody.error.message, /工作区不在允许的根目录内/);

    const relative = await send('oc-workspace-1', 'proj-a');
    assert.equal(relative.status, 400);
    const relativeBody = await relative.json();
    assert.match(relativeBody.error.message, /工作区必须是绝对路径/);
  } finally {
    await harness.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
