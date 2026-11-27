import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

interface Harness {
  base: string;
  adminToken: string;
  gateway: Gateway;
  dir: string;
  workspace: string;
  stateFile: string;
  close: () => Promise<void>;
}

interface Scenario {
  deltas?: string[];
  thinkingDeltas?: string[];
  assistantFallback?: string;
  usage?: Record<string, number>;
  permissionFlow?: boolean;
  authError?: boolean;
  dropSessionOnList?: boolean;
  stateFile?: string;
}

const fakeServerPath = join(import.meta.dirname, 'fake-qoder-server.cjs');

/**
 * fake server 用 writeFileSync 非原子落盘，全量测试高负载下
 * 读到截断文件会 "Unexpected end of JSON input"；轮询到可解析为止。
 */
async function readState(harness: Harness, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(readFileSync(harness.stateFile, 'utf8'));
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function pollQuestions(
  harness: Harness,
  want: number,
  timeoutMs = 15000,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await adminGet(harness, '/admin/api/questions');
    if ((data.questions ?? []).length >= want) return data.questions;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const data = await adminGet(harness, '/admin/api/questions');
  return data.questions ?? [];
}

async function startGateway(options: {
  scenario: Scenario;
  mode?: string;
  env?: Record<string, string>;
  modelUpstream?: string;
}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-qd-test-'));
  const dbPath = join(dir, 'gateway.db').replaceAll('\\', '/');
  const workspace = join(dir, 'ws').replaceAll('\\', '/');
  const stateFile = join(dir, 'state.json').replaceAll('\\', '/');
  const scenarioPath = join(dir, 'scenario.json').replaceAll('\\', '/');
  writeFileSync(
    scenarioPath,
    JSON.stringify({ ...options.scenario, stateFile }),
    'utf8',
  );
  const rootsYaml = `      - ${JSON.stringify(workspace)}`;
  const yaml = `
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-qd
    type: qoder
    priority: 10
    command: ${JSON.stringify(process.execPath)}
    args:
      - ${JSON.stringify(fakeServerPath)}
      - ${JSON.stringify(scenarioPath)}
    env:
${Object.entries(options.env ?? {})
  .map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`)
  .join('\n')}
    workspace: ${JSON.stringify(workspace)}
    mode: ${options.mode ?? 'auto'}
    question_timeout_ms: 30000
    task_timeout_ms: 60000
    startup_timeout_ms: 30000
    workspace_roots:
${rootsYaml}
    models:
      - id: qd-test
        upstream: ${JSON.stringify(options.modelUpstream ?? 'fake-qoder-provider/fake-model')}
        context_window: 100000
        max_output_tokens: 8192
        capabilities:
          tools: true
          vision: false
          reasoning: true`;
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
    dir,
    workspace,
    stateFile,
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
  session = 'qd-session-1',
  workspace?: string,
): Promise<Response> {
  return fetch(`${harness.base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session ? { 'x-code2api-session': session } : {}),
      ...(workspace ? { 'x-code2api-workspace': workspace } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('qoder 任务级：非流式、流式、增量去重与 oneshot 收尾', async () => {
  const harness = await startGateway({
    scenario: {
      deltas: ['fake ', 'reply: '],
      thinkingDeltas: ['思考中'],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    },
  });
  try {
    const first = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'hello-1' }],
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    // thinking_delta 走 reasoning_content，text_delta 走 content
    assert.equal(firstBody.choices[0].message.content, 'fake reply: ');
    assert.equal(firstBody.choices[0].message.reasoning_content, '思考中');
    assert.equal(firstBody.usage.prompt_tokens, 10);
    assert.equal(firstBody.usage.completion_tokens, 5);
    assert.equal(firstBody.usage.prompt_tokens_details.cached_tokens, 2);

    // 复用会话：台账去重后只投递增量 hello-2
    const second = await chat(harness, {
      model: 'qd-test',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: 'hello-1' },
        { role: 'assistant', content: 'fake reply: ' },
        { role: 'user', content: 'hello-2' },
      ],
    });
    assert.equal(second.status, 200);
    const sse = await second.text();
    // fake 每轮固定吐 scenario deltas；增量去重的证据在 state.prompts
    assert.match(sse, /"content":"fake "/);
    assert.match(sse, /"reasoning_content":"思考中"/);
    assert.match(sse, /data: \[DONE\]/);

    // oneshot（不带 x-code2api-session）：任务收尾应 daemon.close_session
    const oneshot = await chat(
      harness,
      { model: 'qd-test', messages: [{ role: 'user', content: 'hello-oneshot' }] },
      '',
    );
    assert.equal(oneshot.status, 200);

    const state = await readState(harness);
    assert.deepEqual(state.prompts, ['hello-1', 'hello-2', 'hello-oneshot']);
    // daemon.list_sessions 返回 local_session_id：复用会话不能每轮重建，只有 oneshot 新开
    assert.equal(state.sessionArgs.length, 2, '复用会话不应重建；oneshot 才新开');
    // open_session 携带 --model / --permission-mode / --include-partial-messages
    const open = state.sessionArgs[0];
    assert.ok(open.worker_args.includes('fake-qoder-provider/fake-model'));
    assert.ok(open.worker_args.includes('--include-partial-messages'));
    assert.deepEqual(state.models[0], {
      model: 'fake-qoder-provider/fake-model',
      via: 'open_session',
    });
    // oneshot 收尾 daemon.close_session（请求在 finally 中异步发出，轮询等待落盘）
    let closes = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await readState(harness);
      closes = Array.isArray(snapshot.closes) ? snapshot.closes.length : 0;
      if (closes >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(closes, 1);
  } finally {
    await harness.close();
  }
});

test('qoder assistant 兜底全文（无流式增量场景）', async () => {
  const harness = await startGateway({
    scenario: { assistantFallback: 'full reply without deltas' },
  });
  try {
    const response = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'full reply without deltas');
  } finally {
    await harness.close();
  }
});

test('qoder 会话失效后重建并重放台账', async () => {
  const harness = await startGateway({
    scenario: { deltas: ['ok'], dropSessionOnList: true },
  });
  try {
    const first = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'hello-1' }],
    });
    assert.equal(first.status, 200);

    // list_sessions 报告会话丢失 → 网关重建会话并把全部未交付消息重放
    const second = await chat(harness, {
      model: 'qd-test',
      messages: [
        { role: 'user', content: 'hello-1' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'hello-2' },
      ],
    });
    assert.equal(second.status, 200);

    const state = await readState(harness);
    assert.equal(state.sessionArgs.length, 2, '应重新 open_session');
    assert.notEqual(state.sessionArgs[0].session_id, state.sessionArgs[1].session_id);
    assert.deepEqual(state.prompts, ['hello-1', 'hello-1\n\nhello-2']);
  } finally {
    await harness.close();
  }
});

test('qoder 权限审批：面板提问 + 放行', async () => {
  const harness = await startGateway({
    scenario: {
      deltas: ['approved reply'],
      permissionFlow: true,
      usage: { input_tokens: 7, output_tokens: 3 },
    },
    mode: 'auto',
  });
  try {
    const pending = chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'run-cmd' }],
    });
    const questions = await pollQuestions(harness, 1);
    assert.equal(questions.length, 1);
    const question = questions[0];
    assert.equal(question.providerId, 'fake-qd');
    assert.equal(question.kind, 'permission');
    assert.equal(question.payload.toolName, 'Bash');
    assert.ok(question.ocSessionId, '面板兼容字段');

    const answered = await fetch(
      `${harness.base}/admin/api/questions/${question.id}/answer`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'once' }),
      },
    );
    assert.equal(answered.status, 200);

    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.choices[0].message.content, /approved reply/);

    const state = await readState(harness);
    assert.deepEqual(state.decisions, ['allow']);
  } finally {
    await harness.close();
  }
});

test('qoder 权限审批：拒绝导致任务失败', async () => {
  const harness = await startGateway({
    scenario: { permissionFlow: true, deltas: ['should not appear'] },
    mode: 'auto',
  });
  try {
    const pending = chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'run-dangerous' }],
    });
    const questions = await pollQuestions(harness, 1);
    assert.equal(questions.length, 1);
    const answered = await fetch(
      `${harness.base}/admin/api/questions/${questions[0].id}/answer`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'reject' }),
      },
    );
    assert.equal(answered.status, 200);

    const response = await pending;
    assert.ok(response.status >= 400);
    const body = await response.json();
    assert.match(body.error.message, /permission denied/);

    const state = await readState(harness);
    assert.deepEqual(state.decisions, ['deny']);
  } finally {
    await harness.close();
  }
});

test('qoder bypass_permissions 模式自动放行', async () => {
  const harness = await startGateway({
    scenario: { deltas: ['auto allowed'], permissionFlow: true },
    mode: 'bypass_permissions',
  });
  try {
    const response = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'run-cmd' }],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'auto allowed');

    const state = await readState(harness);
    assert.deepEqual(state.decisions, ['allow']);
    const questions = await adminGet(harness, '/admin/api/questions');
    assert.equal((questions.questions ?? []).length, 0, '不应产生面板提问');
  } finally {
    await harness.close();
  }
});

test('qoder 工作区白名单：头内路径必须命中根目录', async () => {
  const harness = await startGateway({
    scenario: { deltas: ['ok'] },
  });
  try {
    mkdirSync(harness.workspace, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'code2api-qd-outside-'));
    try {
      const denied = await chat(
        harness,
        { model: 'qd-test', messages: [{ role: 'user', content: 'hi' }] },
        'qd-ws-1',
        outside,
      );
      assert.equal(denied.status, 400);
      const deniedBody = await denied.json();
      assert.match(deniedBody.error.message, /允许的根目录/);

      const allowed = await chat(
        harness,
        { model: 'qd-test', messages: [{ role: 'user', content: 'hi' }] },
        'qd-ws-2',
        harness.workspace,
      );
      assert.equal(allowed.status, 200);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    await harness.close();
  }
});

test('qoder 渠道健康与监控视图', async () => {
  const harness = await startGateway({
    scenario: { deltas: ['hello from qoder'] },
    mode: 'bypass_permissions',
  });
  try {
    const response = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 200);

    const channels = await adminGet(harness, '/admin/api/channels');
    const provider = (channels.channels ?? []).find((c: any) => c.id === 'fake-qd');
    assert.ok(provider);
    assert.equal(provider.qoder.command, process.execPath);
    assert.ok(Array.isArray(provider.qoder.args));
    assert.equal(provider.qoder.mode, 'bypass_permissions');
    assert.equal(provider.qoder.worker.state, 'ready');
    assert.equal(provider.qoder.worker.auth.authenticated, true);
    assert.equal(provider.qoder.worker.auth.method, 'qodercli');
    assert.ok(provider.qoder.pool);
    assert.ok(provider.qoder.pool.maxSessions >= 2);
  } finally {
    await harness.close();
  }
});

test('qoder 渠道 env 配置注入 CLI 子进程', async () => {
  const harness = await startGateway({
    scenario: { deltas: ['env check'] },
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      QODER_PERSONAL_ACCESS_TOKEN: 'fake-pat-token',
    },
  });
  try {
    const response = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 200);

    const data = await readState(harness);
    assert.equal(data.cliEnv.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(data.cliEnv.QODER_PERSONAL_ACCESS_TOKEN, 'fake-pat-token');
    // 网关强制注入 daemon 模式标记
    assert.equal(data.cliEnv.QODER_AGENT_SDK_DAEMON, '1');
    // 真实 runtime 不读这个 env；网关必须显式走 daemon.authenticate 的 accessToken
    assert.deepEqual(data.auth[0], {
      type: 'accessToken',
      accessToken: 'fake-pat-token',
    });
  } finally {
    await harness.close();
  }
});

test('qoder 无 PAT 时回退到 qodercli 本地登录态', async () => {
  const harness = await startGateway({ scenario: { deltas: ['ok'] } });
  try {
    const response = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 200);
    const data = await readState(harness);
    assert.deepEqual(data.auth[0], { type: 'qodercli' });
  } finally {
    await harness.close();
  }
});

test('qoder daemon 认证失败时按 CLI 契约报错', async () => {
  const harness = await startGateway({
    scenario: { authError: true, deltas: ['nope'] },
  });
  try {
    const response = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error.message, /auth failed/);
    const data = await readState(harness);
    assert.equal(data.auth.length, 1);
  } finally {
    await harness.close();
  }
});

test('qoder 无本地 CLI 凭据时错误给出登录指引', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'code2api-qoder-empty-'));
  const previousConfig = process.env.QODER_CONFIG_DIR;
  const previousHome = process.env.QODER_HOME;
  process.env.QODER_CONFIG_DIR = emptyHome;
  process.env.QODER_HOME = emptyHome;
  let harness: Harness | null = null;
  try {
    harness = await startGateway({
      scenario: { authError: true, deltas: ['nope'] },
    });
    const response = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error.message, /IDE 登录不等于 CLI 登录/);
    assert.match(body.error.message, /qoder-cli-credentials\.json/);
    const data = await readState(harness);
    assert.equal(data.auth.length, 1);
  } finally {
    if (harness) await harness.close();
    if (previousConfig === undefined) delete process.env.QODER_CONFIG_DIR;
    else process.env.QODER_CONFIG_DIR = previousConfig;
    if (previousHome === undefined) delete process.env.QODER_HOME;
    else process.env.QODER_HOME = previousHome;
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('qoder 子进程不继承 IDE 注入的 SDK auth payload 环境', async () => {
  const previousPayload = process.env.QODER_SDK_AUTH_PAYLOAD_FILE;
  const previousDir = process.env.QODER_SDK_AUTH_CONFIG_DIR;
  process.env.QODER_SDK_AUTH_PAYLOAD_FILE = join(tmpdir(), 'stale-qoder-auth', 'payload.json');
  process.env.QODER_SDK_AUTH_CONFIG_DIR = join(tmpdir(), 'stale-qoder-auth');
  let harness: Harness | null = null;
  try {
    harness = await startGateway({ scenario: { deltas: ['ok'] } });
    const response = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 200);
    const data = await readState(harness);
    assert.equal(data.cliEnv.QODER_SDK_AUTH_PAYLOAD_FILE, null);
    assert.equal(data.cliEnv.QODER_SDK_AUTH_CONFIG_DIR, null);
    assert.equal(data.cliEnv.QODER_AGENT_SDK_DAEMON, '1');
  } finally {
    if (harness) await harness.close();
    if (previousPayload === undefined) delete process.env.QODER_SDK_AUTH_PAYLOAD_FILE;
    else process.env.QODER_SDK_AUTH_PAYLOAD_FILE = previousPayload;
    if (previousDir === undefined) delete process.env.QODER_SDK_AUTH_CONFIG_DIR;
    else process.env.QODER_SDK_AUTH_CONFIG_DIR = previousDir;
  }
});

test('qoder 冷启动超过 8 秒时不重发 daemon.initialize', async () => {
  const harness = await startGateway({
    scenario: { deltas: ['slow-ok'], initializeDelayMs: 9000 },
  });
  try {
    const response = await chat(harness, {
      model: 'qd-test',
      messages: [{ role: 'user', content: 'slow-start' }],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'slow-ok');
    const data = await readState(harness);
    assert.equal(data.initializeRequests, 1, 'initialize 非幂等，不能超时重发');
  } finally {
    await harness.close();
  }
});
