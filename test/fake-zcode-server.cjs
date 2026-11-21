#!/usr/bin/env node
'use strict';
// 假 ZCode app-server：说 NDJSON "ZCode Protocol"（session/create、session/send、
// session/event、interaction/requestPermission、session/stop、session/close），
// 供 zcode 渠道测试使用。行为由 scenario JSON 控制，投递记录写入 stateFile。

const fs = require('node:fs');

const scenarioPath = process.argv[2] || '';
const scenario = scenarioPath
  ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8'))
  : {};
const statePath = scenario.stateFile || '';
const state = {
  prompts: [],
  decisions: [],
  models: [],
  answers: [],
  // 记录网关注入到 CLI 子进程的环境变量（验证渠道 env 配置确实生效）
  cliEnv: {
    ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR ?? null,
    ZCODE_CREDENTIAL_SECRET_FILE: process.env.ZCODE_CREDENTIAL_SECRET_FILE ?? null,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null,
  },
};
function flushState() {
  if (statePath) fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
flushState();

let seq = 0;
const sessions = new Set();
let currentTurn = null;
const pendingInteractions = new Map();

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function emitEvent(sessionId, type, payload) {
  seq += 1;
  send({
    method: 'session/event',
    params: {
      eventId: `evt_${seq}`,
      sessionId,
      seq,
      timestamp: Date.now(),
      traceId: 'fake-trace',
      type,
      payload,
    },
  });
}

function askPermission(sessionId, toolName) {
  return new Promise((resolve) => {
    seq += 1;
    const id = `srv_${seq}`;
    const timer = setTimeout(() => {
      if (pendingInteractions.has(id)) {
        pendingInteractions.delete(id);
        resolve('deny');
      }
    }, 120000);
    pendingInteractions.set(id, (result) => {
      clearTimeout(timer);
      resolve(result && result.decision === 'allow' ? 'allow' : 'deny');
    });
    send({
      id,
      method: 'interaction/requestPermission',
      params: {
        sessionId,
        requestId: `perm_${id}`,
        toolName,
        riskLevel: 'medium',
        reason: 'fake scenario',
        input: {},
      },
    });
  });
}

function askUserInput(sessionId, prompt) {
  return new Promise((resolve) => {
    seq += 1;
    const id = `srv_${seq}`;
    const timer = setTimeout(() => {
      if (pendingInteractions.has(id)) {
        pendingInteractions.delete(id);
        resolve({});
      }
    }, 120000);
    pendingInteractions.set(id, (result) => {
      clearTimeout(timer);
      resolve(result ?? {});
    });
    send({
      id,
      method: 'interaction/requestUserInput',
      params: { sessionId, requestId: `input_${id}`, prompt, inputType: 'text' },
    });
  });
}

// 模拟真实 CLI (v0.17.1) 的 runtime-materialization 握手：
// 会话创建后反向询问 runtime preferences，并对回答做 strict zod 校验
// （nativeSearchEnhancementsEnabled 必填 boolean，未知键报 ZodError，会话 unloaded）。
function askRuntimePreferences(sessionId) {
  return new Promise((resolve) => {
    seq += 1;
    const id = `srv_${seq}`;
    pendingInteractions.set(id, (result) => resolve({ id, result: result ?? {} }));
    send({
      id,
      method: 'session/requestRuntimePreferences',
      params: { sessionId, scope: 'runtime-materialization' },
    });
  });
}

// 与真实 CLI 的 _un schema 对齐：strict，nativeSearchEnhancementsEnabled 必填 boolean。
function validateRuntimePreferences(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return 'Invalid input: expected object';
  }
  const allowed = [
    'additionalDirectories',
    'nativeSearchEnhancementsEnabled',
    'toolSearchMode',
    'subagentRuntimeConfigEnabled',
    'appControlEnabled',
    'memoryEnabled',
    'askUserQuestionAutoResolutionEnabled',
    'integratedTerminalShell',
    'modelContextBudgetStrategy',
  ];
  const unknown = Object.keys(result).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    return `Unrecognized key: "${unknown[0]}"`;
  }
  if (typeof result.nativeSearchEnhancementsEnabled !== 'boolean') {
    return 'Invalid input: expected boolean, received undefined [nativeSearchEnhancementsEnabled]';
  }
  return null;
}

async function runTurn(sessionId, content) {
  state.prompts.push(content);
  flushState();
  emitEvent(sessionId, 'turn.started', { turnNumber: 1, input: content });
  if (scenario.permissionFlow) {
    const decision = await askPermission(sessionId, 'Bash');
    state.decisions.push(decision);
    flushState();
    if (decision !== 'allow') {
      emitEvent(sessionId, 'turn.completed', {
        response: '',
        usage: {},
        toolCallCount: 0,
        duration: 1,
        resultType: 'error_during_execution',
      });
      return;
    }
  }
  if (scenario.userInputFlow) {
    const answer = await askUserInput(sessionId, '请确认目标');
    state.answers.push(answer);
    flushState();
  }
  const deltas = scenario.deltas || ['fake ', 'reply'];
  for (const delta of deltas) {
    emitEvent(sessionId, 'part.delta', {
      messageId: 'm1',
      partId: 'p1',
      field: 'text',
      delta,
    });
  }
  const usage = scenario.usage || { inputTokens: 10, outputTokens: 5 };
  emitEvent(sessionId, 'turn.completed', {
    response: scenario.response ?? deltas.join(''),
    usage,
    toolCallCount: 0,
    duration: 5,
    resultType: scenario.resultType || 'success',
  });
}

function handleLine(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  const id = frame.id;
  if (frame.method && id !== undefined && id !== null) {
    void handleRequest(String(id), frame.method, frame.params || {});
    return;
  }
  if (id !== undefined && id !== null && ('result' in frame || 'error' in frame)) {
    const waiter = pendingInteractions.get(String(id));
    if (waiter) {
      pendingInteractions.delete(String(id));
      waiter(frame.result ?? {});
    }
  }
}

async function handleRequest(id, method, params) {
  try {
    if (method === 'session/list') {
      send({ id, result: { sessions: [] } });
      return;
    }
    if (method === 'session/lifecycle/getState') {
      const sessionId = params.sessionId;
      if (sessions.has(sessionId)) {
        send({ id, result: { sessionId, state: 'ready' } });
      } else {
        send({
          id,
          error: { code: -32000, message: `session ${sessionId} does not exist` },
        });
      }
      return;
    }
    if (method === 'session/create') {
      const workspace = params.workspace || {};
      if (
        scenario.requireWorkspace &&
        typeof workspace.workspacePath === 'string' &&
        !workspace.workspacePath.startsWith(scenario.requireWorkspace)
      ) {
        send({
          id,
          error: { code: -32602, message: 'workspace not allowed' },
        });
        return;
      }
      seq += 1;
      const sessionId = `sess_fake_${seq}`;
      send({ method: 'session/lifecycle/changed', params: { sessionId, state: 'starting', lastError: null } });
      const { result } = await askRuntimePreferences(sessionId);
      const invalid = validateRuntimePreferences(result);
      if (invalid) {
        // 与真实 CLI 一致：校验失败 → 会话 stopping/unloaded + ZodError 错误帧
        send({ method: 'session/lifecycle/changed', params: { sessionId, state: 'unloaded', lastError: { operation: 'ensureReady', code: 'operationFailed', message: invalid } } });
        send({
          id,
          error: { code: -32603, data: { name: 'ZodError' }, message: invalid },
        });
        return;
      }
      if (scenario.requireReasoningLevel && !params.model?.options?.reasoningLevel) {
        // 与真实 CLI 一致：部分模型强制要求显式推理档位
        send({ method: 'session/lifecycle/changed', params: { sessionId, state: 'unloaded', lastError: { operation: 'ensureReady', code: 'operationFailed', message: 'Reasoning level is required' } } });
        send({
          id,
          error: { code: -32603, message: `Reasoning level is required for ${params.model?.providerId}/${params.model?.modelId}` },
        });
        return;
      }
      sessions.add(sessionId);
      send({ method: 'session/lifecycle/changed', params: { sessionId, state: 'ready', lastError: null } });
      if (params.model) {
        state.models.push(params.model);
        flushState();
      }
      send({
        id,
        result: {
          protocol: { name: 'ZCode Protocol', version: 1 },
          session: { sessionId },
        },
      });
      return;
    }
    if (method === 'session/setModel') {
      if (params.model) {
        state.models.push(params.model);
        flushState();
      }
      send({ id, result: {} });
      return;
    }
    if (method === 'session/send') {
      send({
        id,
        result: { sessionId: params.sessionId, accepted: true, stateRevision: 1 },
      });
      currentTurn = { sessionId: params.sessionId, cancelled: false };
      await runTurn(params.sessionId, params.content ?? '');
      currentTurn = null;
      return;
    }
    if (method === 'session/stop') {
      if (currentTurn) currentTurn.cancelled = true;
      send({ id, result: {} });
      return;
    }
    if (method === 'session/close') {
      if (typeof params.sessionId === 'string') sessions.delete(params.sessionId);
      send({ id, result: {} });
      return;
    }
    send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  } catch (error) {
    send({
      id,
      error: { code: -32603, message: String((error && error.message) || error) },
    });
  }
}

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handleLine(line);
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
