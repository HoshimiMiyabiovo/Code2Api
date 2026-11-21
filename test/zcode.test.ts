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
  response?: string;
  usage?: Record<string, number>;
  resultType?: string;
  permissionFlow?: boolean;
  userInputFlow?: boolean;
  stateFile?: string;
}

const fakeServerPath = join(import.meta.dirname, 'fake-zcode-server.cjs');

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
  extraRoots?: string[];
  env?: Record<string, string>;
  modelReasoningEffort?: string;
}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-zc-test-'));
  const dbPath = join(dir, 'gateway.db').replaceAll('\\', '/');
  const workspace = join(dir, 'ws').replaceAll('\\', '/');
  const stateFile = join(dir, 'state.json').replaceAll('\\', '/');
  const scenarioPath = join(dir, 'scenario.json').replaceAll('\\', '/');
  writeFileSync(
    scenarioPath,
    JSON.stringify({ ...options.scenario, stateFile }),
    'utf8',
  );
  const roots = [workspace, ...(options.extraRoots ?? [])];
  const rootsYaml = roots.map((root) => `      - ${JSON.stringify(root)}`).join('\n');
  const yaml = `
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-zc
    type: zcode
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
    mode: ${options.mode ?? 'build'}
    question_timeout_ms: 30000
    task_timeout_ms: 60000
    workspace_roots:
${rootsYaml}
    models:
      - id: zc-test
        upstream: fake-zc-provider/fake-model
        context_window: 100000
        max_output_tokens: 8192
        capabilities:
          tools: true
          vision: false
          reasoning: true
${options.modelReasoningEffort ? `        reasoning_effort: ${options.modelReasoningEffort}\n` : ''}`;
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
  session = 'zc-session-1',
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

test('zcode 任务级：非流式、流式与增量去重', async () => {
  const harness = await startGateway({
    scenario: {
      deltas: ['fake ', 'reply: '],
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  });
  try {
    const first = await chat(harness, {
      model: 'zc-test',
      messages: [{ role: 'user', content: 'hello-1' }],
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.choices[0].message.content, 'fake reply: ');
    assert.deepEqual(firstBody.usage, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });

    const second = await chat(harness, {
      model: 'zc-test',
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
    // 分片逐 delta 到达，两个增量都应出现
    assert.match(sse, /"content":"fake "/);
    assert.match(sse, /"content":"reply: "/);
    assert.match(sse, /data: \[DONE\]/);
    assert.match(sse, /"usage":\{"prompt_tokens":10,"completion_tokens":5/);

    const state = JSON.parse(readFileSync(harness.stateFile, 'utf8'));
    // 台账去重：第二轮只投递增量 hello-2
    assert.deepEqual(state.prompts, ['hello-1', 'hello-2']);
    // session/create 传入了 providerId/modelId 形式的模型
    assert.equal(state.models[0].providerId, 'fake-zc-provider');
    assert.equal(state.models[0].modelId, 'fake-model');
  } finally {
    await harness.close();
  }
});

test('zcode 权限审批：面板提问 + 放行/拒绝', async () => {
  const harness = await startGateway({
    scenario: {
      deltas: ['approved reply'],
      permissionFlow: true,
      usage: { inputTokens: 7, outputTokens: 3 },
    },
    mode: 'build',
  });
  try {
    const pending = chat(harness, {
      model: 'zc-test',
      messages: [{ role: 'user', content: 'run-cmd' }],
    });
    const questions = await pollQuestions(harness, 1);
    assert.equal(questions.length, 1);
    const question = questions[0];
    assert.equal(question.providerId, 'fake-zc');
    assert.equal(question.kind, 'permission');
    assert.equal(question.payload.toolName, 'Bash');
    assert.ok(question.ocSessionId);

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
    // 内容包含提示 note 前缀，最终回答在末尾
    assert.match(body.choices[0].message.content, /approved reply/);

    const state = JSON.parse(readFileSync(harness.stateFile, 'utf8'));
    assert.deepEqual(state.decisions, ['allow']);
  } finally {
    await harness.close();
  }
});

test('zcode 权限审批：拒绝导致任务失败', async () => {
  const harness = await startGateway({
    scenario: { permissionFlow: true, deltas: ['should not appear'] },
    mode: 'build',
  });
  try {
    const pending = chat(harness, {
      model: 'zc-test',
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
    assert.match(body.error.message, /执行出错/);

    const state = JSON.parse(readFileSync(harness.stateFile, 'utf8'));
    assert.deepEqual(state.decisions, ['deny']);
  } finally {
    await harness.close();
  }
});

test('zcode 工作区白名单：头内路径必须命中根目录', async () => {
  const harness = await startGateway({
    scenario: { deltas: ['ok'] },
    extraRoots: [],
  });
  try {
    // 白名单根目录必须真实存在才能通过 realpath 校验
    mkdirSync(harness.workspace, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'code2api-zc-outside-'));
    try {
      const denied = await chat(
        harness,
        { model: 'zc-test', messages: [{ role: 'user', content: 'hi' }] },
        'zc-ws-1',
        outside,
      );
      assert.equal(denied.status, 400);
      const deniedBody = await denied.json();
      assert.match(deniedBody.error.message, /允许的根目录/);

      const allowed = await chat(
        harness,
        { model: 'zc-test', messages: [{ role: 'user', content: 'hi' }] },
        'zc-ws-2',
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

test('zcode 渠道健康与监控视图', async () => {
  const harness = await startGateway({
    scenario: { deltas: ['hello from zcode'] },
    mode: 'yolo',
  });
  try {
    const response = await chat(harness, {
      model: 'zc-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 200);

    const channels = await adminGet(harness, '/admin/api/channels');
    const provider = (channels.channels ?? []).find((c: any) => c.id === 'fake-zc');
    assert.ok(provider);
    assert.equal(provider.zcode.command, process.execPath);
    assert.ok(Array.isArray(provider.zcode.args));
    assert.equal(provider.zcode.mode, 'yolo');
    assert.equal(provider.zcode.worker.state, 'ready');
    assert.ok(provider.zcode.pool);
    assert.ok(provider.zcode.pool.maxSessions >= 2);
  } finally {
    await harness.close();
  }
});

test('zcode 渠道 env 配置注入 CLI 子进程', async () => {
  const harness = await startGateway({
    scenario: { deltas: ['env check'] },
    env: {
      ZCODE_DATA_BASE_DIR: '/tmp/zcode-cli-profile',
      ZCODE_CREDENTIAL_SECRET_FILE: '/tmp/zcode-cli-profile/credential-secret',
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'F:/Program Files/zcode/resources/config/provider/zcode-builtin.json',
    },
  });
  try {
    const response = await chat(harness, {
      model: 'zc-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 200);

    const data = JSON.parse(readFileSync(harness.stateFile, 'utf8'));
    assert.deepEqual(data.cliEnv, {
      ZCODE_DATA_BASE_DIR: '/tmp/zcode-cli-profile',
      ZCODE_CREDENTIAL_SECRET_FILE: '/tmp/zcode-cli-profile/credential-secret',
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:
        'F:/Program Files/zcode/resources/config/provider/zcode-builtin.json',
    });
  } finally {
    await harness.close();
  }
});

test('zcode 模型默认推理档位注入 session/create', async () => {
  // fake server 要求 options.reasoningLevel；客户端未带 reasoning_effort，
  // 网关应回落到模型配置的 reasoning_effort（与真实 CLI "Reasoning level is required" 对齐）。
  const harness = await startGateway({
    scenario: { requireReasoningLevel: true, deltas: ['with reasoning'] },
    modelReasoningEffort: 'max',
  });
  try {
    const response = await chat(harness, {
      model: 'zc-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'with reasoning');

    const data = JSON.parse(readFileSync(harness.stateFile, 'utf8'));
    assert.equal(data.models[0].options.reasoningLevel, 'max');
  } finally {
    await harness.close();
  }
});

test('zcode 缺少推理档位时按 CLI 契约失败', async () => {
  const harness = await startGateway({
    scenario: { requireReasoningLevel: true, deltas: ['nope'] },
  });
  try {
    const response = await chat(harness, {
      model: 'zc-test',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error.message, /Reasoning level is required/);
  } finally {
    await harness.close();
  }
});
