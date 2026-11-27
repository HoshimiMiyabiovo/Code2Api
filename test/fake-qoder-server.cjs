#!/usr/bin/env node
'use strict';
// 假 qoder daemon：说 stdio NDJSON「qoder --sdk」协议（daemon.initialize 握手、
// daemon.open_session、user 消息帧、stream_event/assistant/result、can_use_tool 反向请求），
// 供 qoder 渠道测试使用。行为由 scenario JSON 控制，投递记录写入 stateFile。

const fs = require('node:fs');

// daemon.get_models 的默认目录（形状对齐 runtime 1.1.86 的 YCe 映射）
const DEFAULT_CATALOG = [
  {
    modelId: 'fake-qoder-model',
    value: 'fake-qoder-model',
    displayName: 'Fake Qoder 主模型',
    description: 'fake catalog entry',
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    isReasoning: true,
    isVl: true,
    isDefault: true,
    isEnabled: true,
    efforts: ['low', 'medium', 'high'],
  },
  {
    modelId: 'fake-qoder-eco',
    value: 'fake-qoder-eco',
    displayName: 'Fake Qoder Eco',
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    isEnabled: true,
  },
  {
    modelId: 'fake-qoder-hidden',
    displayName: 'Fake Qoder Hidden',
    isEnabled: false,
  },
];

const scenarioPath = process.argv[2] || '';
const scenario = scenarioPath
  ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8'))
  : {};
const statePath = scenario.stateFile || '';
const state = {
  prompts: [],
  decisions: [],
  models: [],
  sessionArgs: [],
  closes: [],
  auth: [],
  initializeRequests: 0,
  // 记录网关注入到 CLI 子进程的环境变量（验证渠道 env 配置确实生效）
  cliEnv: {
    QODER_AGENT_SDK_DAEMON: process.env.QODER_AGENT_SDK_DAEMON ?? null,
    QODER_PERSONAL_ACCESS_TOKEN: process.env.QODER_PERSONAL_ACCESS_TOKEN ?? null,
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
    QODER_SDK_AUTH_PAYLOAD_FILE: process.env.QODER_SDK_AUTH_PAYLOAD_FILE ?? null,
    QODER_SDK_AUTH_CONFIG_DIR: process.env.QODER_SDK_AUTH_CONFIG_DIR ?? null,
  },
};
function flushState() {
  if (statePath) fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
flushState();

let seq = 0;
let nextSession = 0;
const sessions = new Set();
const pendingInteractions = new Map();

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

// 真实 daemon 的 session id 放在 control_response 信封顶层（writeSuccess），
// payload 里通常没有；fake 必须按真实形状回包，否则会把网关的解析 bug 盖住。
function respond(requestId, result, sessionId) {
  send({
    type: 'control_response',
    ...(typeof sessionId === 'string' && sessionId ? { session_id: sessionId } : {}),
    response: {
      subtype: 'success',
      request_id: requestId,
      ...(result === undefined ? {} : { response: result }),
    },
  });
}

// 真实 runtime 对 error 做 strict zod 校验：必须是字符串。
// 这里也严格一点，防止网关再回 { message } 对象。
function respondError(requestId, message) {
  send({
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error: String(message) },
  });
}

// can_use_tool 反向请求：挂起等待网关应答，strict 校验 behavior 字段。
function askPermission(sessionId, toolName) {
  return new Promise((resolve) => {
    seq += 1;
    const requestId = `daemon_sdk_${seq}`;
    const timer = setTimeout(() => {
      if (pendingInteractions.has(requestId)) {
        pendingInteractions.delete(requestId);
        resolve('timeout-deny');
      }
    }, 120000);
    pendingInteractions.set(requestId, (response) => {
      clearTimeout(timer);
      // 与真实 SDK 的响应校验对齐：behavior 必须是 allow/deny
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        resolve('invalid: not an object');
        return;
      }
      const allowed = ['behavior', 'updatedInput', 'message'];
      const unknown = Object.keys(response).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) {
        resolve(`invalid: Unrecognized key "${unknown[0]}"`);
        return;
      }
      if (response.behavior !== 'allow' && response.behavior !== 'deny') {
        resolve('invalid: behavior must be allow or deny');
        return;
      }
      resolve(response.behavior);
    });
    send({
      type: 'control_request',
      request_id: requestId,
      session_id: sessionId,
      request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        input: { command: 'ls' },
        tool_use_id: `tool_${seq}`,
        permission_suggestions: [],
      },
    });
  });
}

async function runTurn(sessionId, content) {
  state.prompts.push(content);
  flushState();
  // 与真实 CLI 一致：每轮先发 system/init
  send({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    protocol_version: '1.5.0',
    model: 'fake-model',
    permission_mode: 'auto',
  });
  if (scenario.permissionFlow) {
    const decision = await askPermission(sessionId, 'Bash');
    state.decisions.push(decision);
    flushState();
    if (decision !== 'allow') {
      send({
        type: 'result',
        subtype: 'error',
        is_error: true,
        session_id: sessionId,
        errors: [`permission denied (${decision})`],
        terminal_reason: 'aborted_tools',
        usage: {},
      });
      return;
    }
  }
  const deltas = scenario.deltas || [];
  if (deltas.length === 0 && scenario.assistantFallback) {
    // 无流式增量场景：只发 assistant 兜底全文，验证网关 fallback 逻辑
    send({
      type: 'assistant',
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: scenario.assistantFallback }],
      },
    });
  }
  for (const delta of deltas) {
    send({
      type: 'stream_event',
      session_id: sessionId,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } },
    });
  }
  for (const thinking of scenario.thinkingDeltas || []) {
    send({
      type: 'stream_event',
      session_id: sessionId,
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking } },
    });
  }
  const usage = scenario.usage || { input_tokens: 10, output_tokens: 5 };
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    result: (scenario.assistantFallback || '') + deltas.join(''),
    terminal_reason: 'end_turn',
    usage,
  });
}

function extractText(frame) {
  const content = frame.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function handleLine(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame.type === 'control_response') {
    const requestId = frame.response?.request_id;
    const waiter = requestId ? pendingInteractions.get(String(requestId)) : undefined;
    if (waiter) {
      pendingInteractions.delete(String(requestId));
      waiter(frame.response.response ?? frame.response.error ?? {});
    }
    return;
  }
  if (frame.type === 'control_request' && typeof frame.request_id === 'string') {
    void handleRequest(String(frame.request_id), frame.request || {}, frame.session_id);
    return;
  }
  if (frame.type === 'user' && typeof frame.session_id === 'string') {
    void runTurn(frame.session_id, extractText(frame));
    return;
  }
  // keep_alive / system / status_event 等通知忽略
}

async function handleRequest(requestId, request, sessionId) {
  try {
    const type = request.subtype || request.type;
    if (type === 'daemon.initialize') {
      if (request.daemon_protocol_version !== 2) {
        respondError(requestId, `unsupported daemon_protocol_version: ${request.daemon_protocol_version}`);
        return;
      }
      state.cliEnvChecked = true;
      state.initializeRequests += 1;
      flushState();
      const reply = () =>
        respond(requestId, {
          daemon_protocol_version: 2,
          daemon_version: '1.1.86-hotfix.17',
          capabilities: ['multi_session_v2', 'session_delete_v1', 'daemon_queries_v1'],
        });
      if (scenario.initializeDelayMs) setTimeout(reply, scenario.initializeDelayMs);
      else reply();
      return;
    }
    if (type === 'daemon.authenticate') {
      // 真实 daemon.authenticate 收 { auth: {type, ...} }，返回 {authenticated:boolean}。
      state.auth.push(request.auth ?? null);
      flushState();
      if (scenario.authError) {
        respondError(requestId, 'auth failed: not logged in (no PAT, no cli login state)');
        return;
      }
      respond(requestId, { authenticated: true });
      return;
    }
    if (type === 'daemon.open_session') {
      seq += 1;
      nextSession += 1;
      const sid = `sess_fake_${nextSession}`;
      sessions.add(sid);
      state.sessionArgs.push({
        cwd: request.cwd ?? null,
        worker_args: request.worker_args ?? [],
        session_id: sid,
      });
      // 从 worker_args 里提取 --model 便于断言
      const args = request.worker_args ?? [];
      const modelIndex = args.indexOf('--model');
      if (modelIndex >= 0 && typeof args[modelIndex + 1] === 'string') {
        state.models.push({ model: args[modelIndex + 1], via: 'open_session' });
      }
      flushState();
      // 与真实 daemon 一致：session id 走 control_response 信封顶层。
      respond(requestId, {}, sid);
      return;
    }
    if (type === 'daemon.list_sessions') {
      // dropSessionOnList：模拟 daemon 重启后会话丢失，回归网关“重建会话+重放账本”
      // 真实字段是 local_session_id，不是 session_id/id。
      const list = scenario.dropSessionOnList ? [] : [...sessions];
      respond(requestId, {
        sessions: list.map((sid) => ({ local_session_id: sid, state: 'ready' })),
      });
      return;
    }
    if (type === 'initialize') {
      // query 级 initialize（open_session 之后网关补发）
      respond(requestId, { capabilities: [], commands: [] });
      return;
    }
    if (type === 'set_model') {
      state.models.push({ model: request.model ?? null, via: 'set_model', session_id: sessionId });
      flushState();
      respond(requestId, {});
      return;
    }
    if (type === 'daemon.get_models') {
      // 真实 daemon 返回 {models:[...]}；fetchStrategy 缺省 = auto（可用本地缓存）。
      state.modelsQuery = request;
      flushState();
      respond(requestId, { models: scenario.catalog ?? DEFAULT_CATALOG });
      return;
    }
    if (type === 'interrupt') {
      respond(requestId, { still_queued: [] });
      return;
    }
    if (type === 'daemon.close_session') {
      // 真实 daemon 从 control_request 信封读 session_id；payload 同名字段仅兼容旧版。
      const target =
        typeof sessionId === 'string' && sessionId
          ? sessionId
          : typeof request.session_id === 'string'
            ? request.session_id
            : '';
      if (target) {
        sessions.delete(target);
        state.closes.push(target);
        flushState();
      }
      respond(requestId, {});
      return;
    }
    if (type === 'daemon.shutdown') {
      respond(requestId, {});
      return;
    }
    respondError(requestId, `unknown request type ${type}`);
  } catch (error) {
    respondError(requestId, String((error && error.message) || error));
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
