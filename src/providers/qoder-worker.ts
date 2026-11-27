import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QoderProviderConfig } from '../config.js';
import { qoderCliLoginHint } from '../core/qoder-install.js';
import { UpstreamError } from '../errors.js';
import { log } from '../logger.js';

export type QoderWorkerState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'error'
  | 'stopped';

export interface QoderWorkerSnapshot {
  state: QoderWorkerState;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
  workspace: string | null;
  /** 子进程 stderr 尾部（排障用），经 admin API 透出。 */
  logTail: string[];
  /** daemon.authenticate 结果（凭据状态，经 admin API 透出）。 */
  auth: QoderAuthSnapshot;
}

export interface QoderAuthSnapshot {
  method: 'accessToken' | 'serviceAccount' | 'qodercli' | 'none' | null;
  authenticated: boolean | null;
  error: string | null;
}

/**
 * daemon.get_models 的模型条目（runtime 1.1.86 的 YCe 映射实测字段）。
 * 只有 id 是必需项，其余字段按可选处理，避免 CLI 升级后整条目录消失。
 */
export interface QoderModelInfo {
  /** runtime 的模型标识（modelId）：open_session 的 --model / upstream 都用它。 */
  id: string;
  displayName: string;
  description: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning: boolean;
  vision: boolean;
  isDefault: boolean;
  /** 该模型支持的推理强度档位（runtime 返回 efforts 时）。 */
  efforts?: string[];
  priceFactor?: number;
}

/**
 * qoder daemon（`--sdk` 模式）按行分隔的 JSON 帧。
 * 会话内消息（assistant / stream_event / result / system 等）带顶层 session_id 路由。
 */
export interface QoderProtocolFrame {
  type: string;
  session_id?: string;
  subtype?: string;
  uuid?: string;
  [key: string]: unknown;
}

/** CLI→客户端的反向请求（can_use_tool / elicitation 等），需要客户端以 control_response 应答。 */
export interface QoderServerRequest {
  requestId: string;
  sessionId: string | null;
  type: string;
  payload: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout | null;
}

/** daemon.initialize 握手参数（协议版本 2，IDE 内嵌 qodercli 1.1.86 实测）。 */
const DAEMON_PROTOCOL_VERSION = 2;
const KEEP_ALIVE_INTERVAL_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export class QoderWorker {
  private child: ChildProcess | null = null;
  private childPid: number | null = null;
  private state: QoderWorkerState = 'idle';
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscribers = new Map<
    string,
    Set<(frame: QoderProtocolFrame) => void>
  >();
  private readonly exitListeners = new Set<(message: string) => void>();
  private interactionHandler:
    | ((request: QoderServerRequest) => Promise<unknown> | unknown)
    | null = null;
  private readonly logTail: string[] = [];
  private stdoutBuffer = '';
  private auth: QoderAuthSnapshot = { method: null, authenticated: null, error: null };

  constructor(private readonly config: QoderProviderConfig) {}

  snapshot(): QoderWorkerSnapshot {
    return {
      state: this.state,
      pid: this.childPid,
      restarts: this.restarts,
      lastError: this.lastError,
      startedAt: this.startedAt,
      workspace: resolve(process.cwd(), this.config.workspace),
      logTail: this.logTail.slice(-20),
      auth: { ...this.auth },
    };
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  setInteractionHandler(
    handler: (request: QoderServerRequest) => Promise<unknown> | unknown,
  ): void {
    this.interactionHandler = handler;
  }

  onExit(listener: (message: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  subscribeSession(
    sessionId: string,
    handler: (frame: QoderProtocolFrame) => void,
  ): () => void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(handler);
    return () => {
      const current = this.subscribers.get(sessionId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.subscribers.delete(sessionId);
    };
  }

  async ensureStarted(): Promise<void> {
    if (this.stopping) {
      throw new UpstreamError('qoder worker 已停止', { category: 'server', retryable: false });
    }
    if (this.state === 'ready') return;
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  /**
   * 发起一次 daemon/query 控制请求并等待 control_response。
   * daemon.* 请求与 query 级请求共用 type 字段（SDK 无 subtype 时以 type 补）。
   */
  async request<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    params?: Record<string, unknown>,
    opts?: { sessionId?: string; timeoutMs?: number },
  ): Promise<T> {
    if (!this.child || this.state !== 'ready') {
      throw new UpstreamError('qoder worker 未就绪', { category: 'server', retryable: false });
    }
    return this.dispatch<T>(type, params, opts);
  }

  /**
   * daemon.get_models：读 daemon 侧的模型目录（authenticate 之后的账号可见模型）。
   * 不带 fetchStrategy = auto：已登录时走 runtime 的 listModels()（可用本地缓存，不强制联网），
   * 未登录时回落本地缓存而不是抛 AUTH_REQUIRED。
   */
  async getModels(options?: { timeoutMs?: number }): Promise<QoderModelInfo[]> {
    const result = await this.request<{ models?: unknown }>(
      'daemon.get_models',
      {},
      { timeoutMs: options?.timeoutMs ?? 30000 },
    );
    return normalizeQoderModels(result.models);
  }

  /** 绕过就绪守卫的实际发送逻辑（就绪探针在 starting 阶段也要能发握手）。 */
  private dispatch<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    params?: Record<string, unknown>,
    opts?: { sessionId?: string; timeoutMs?: number },
  ): Promise<T> {
    const requestId = `c2a-${this.nextRequestId++}`;
    const timeoutMs = opts?.timeoutMs ?? 60000;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const pending: PendingRequest = {
        resolve: resolveRequest as (value: Record<string, unknown>) => void,
        reject: rejectRequest,
        timer: null,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(requestId);
          rejectRequest(
            new UpstreamError(`qoder 协议请求 ${type} 超时（${timeoutMs}ms）`, {
              category: 'timeout',
            }),
          );
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(requestId, pending);
      this.writeFrame({
        type: 'control_request',
        request_id: requestId,
        ...(opts?.sessionId ? { session_id: opts.sessionId } : {}),
        request: { type, ...(params ?? {}) },
      });
    });
  }

  /** 向指定会话投递一条 user 消息（普通帧，非 control_request）。 */
  sendUserMessage(sessionId: string, text: string): void {
    this.writeFrame({
      type: 'user',
      uuid: `c2a-${randomId()}`,
      session_id: sessionId,
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    });
  }

  private writeFrame(frame: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin) {
      throw new UpstreamError('qoder worker stdin 不可用', { category: 'server' });
    }
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private async startInternal(): Promise<void> {
    this.state = 'starting';
    const workspace = resolve(process.cwd(), this.config.workspace);
    try {
      mkdirSync(workspace, { recursive: true });
    } catch {
      // 工作区创建失败留给 spawn 报错
    }
    // 网关自动追加 --sdk（与 zcode 自动追加 app-server 同款约定）；
    // IDE 内嵌 runtime 需要 command=Qoder.exe + env ELECTRON_RUN_AS_NODE=1（配置里给）。
    const baseArgs = this.config.args.includes('--sdk')
      ? [...this.config.args]
      : [...this.config.args, '--sdk'];
    log.info(
      `qoder[${this.config.id}] 启动: ${this.config.command} ${baseArgs.join(' ')}`,
    );
    let child: ChildProcess;
    try {
      // Qoder IDE 会给子进程注入它自己的 SDK auth payload 路径；网关继承后
      // runtime 会去找那个临时文件，而不是 ~/.qoder 里的 CLI 登录态。
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv.QODER_SDK_AUTH_PAYLOAD_FILE;
      delete childEnv.QODER_SDK_AUTH_CONFIG_DIR;
      child = spawn(this.config.command, baseArgs, {
        cwd: workspace,
        env: {
          ...childEnv,
          ...this.config.env,
          // SDK 以此判定 daemon 模式（IDE 拉起时同样注入）
          QODER_AGENT_SDK_DAEMON: '1',
        },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.setError(`无法启动 qoder: ${(error as Error).message}`);
      throw new UpstreamError(this.lastError ?? '无法启动 qoder', {
        category: 'server',
        retryable: false,
      });
    }
    this.child = child;
    this.childPid = child.pid ?? null;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logTail.push(line);
        if (this.logTail.length > 80) this.logTail.shift();
      }
    });
    child.on('error', (error) => {
      this.lastError = error.message;
    });
    child.on('exit', (code, signal) => {
      const message = `qoder 进程退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      this.child = null;
      this.childPid = null;
      this.stopKeepAlive();
      this.failPendingRequests(message);
      if (this.stopping) {
        this.state = 'stopped';
        return;
      }
      this.setError(message);
      for (const listener of [...this.exitListeners]) {
        try {
          listener(message);
        } catch {
          // 忽略监听器异常
        }
      }
      if (this.restarts < this.config.restartBudget) {
        this.restarts += 1;
        this.state = 'restarting';
        this.restartTimer = setTimeout(() => {
          void this.ensureStarted().catch(() => {});
        }, Math.min(1000 * this.restarts, 5000));
      }
    });

    try {
      await this.waitReady();
      // 0.5.17 daemon.initialize 不消费 PAT；凭据要走 daemon.authenticate。
      // 失败即认为渠道不可用（比 ready 后每个任务 401 更早暴露）。
      await this.authenticate();
    } catch (error) {
      await this.killChild();
      this.setError(`qoder 启动失败: ${(error as Error).message}`);
      throw error;
    }
    this.state = 'ready';
    this.startedAt = Date.now();
    this.lastError = null;
    this.startKeepAlive();
    log.info(`qoder[${this.config.id}] 就绪 (pid ${this.childPid ?? '?'})`);
  }

  private async waitReady(): Promise<void> {
    if (!this.child) {
      throw new Error(this.lastError ?? 'qoder 进程已退出');
    }
    try {
      // daemon.initialize 不是幂等操作：0.5.21 冷启动可能超过 10 秒，
      // 超时后重发会收到 "initialization is already in progress"。
      // 因此单次使用完整启动预算等待，不重试。
      await this.dispatch(
        'daemon.initialize',
        {
          daemon_protocol_version: DAEMON_PROTOCOL_VERSION,
          sdk_version: 'code2api-gateway',
          capabilities: ['multi_session_v2', 'session_delete_v1', 'daemon_queries_v1'],
        },
        { timeoutMs: this.config.startupTimeoutMs },
      );
    } catch (error) {
      if (!this.child) {
        throw new Error(this.lastError ?? 'qoder 进程已退出');
      }
      throw new Error(
        `qoder daemon 未在 ${this.config.startupTimeoutMs}ms 内就绪: ${(error as Error).message}`,
      );
    }
  }

  /**
   * daemon.authenticate 的候选凭据（顺序即优先级）：
   * accessToken（PAT）→ serviceAccount → qodercli（复用本机 CLI/IDE 登录态）。
   * 真实 runtime 不读 QODER_PERSONAL_ACCESS_TOKEN，必须显式把 token 送进 auth。
   */
  private authCandidates(): Array<{
    method: QoderAuthSnapshot['method'];
    auth: Record<string, unknown>;
  }> {
    const envValue = (...keys: string[]): string => {
      for (const key of keys) {
        const value = this.config.env[key] ?? process.env[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return '';
    };
    const candidates: Array<{
      method: QoderAuthSnapshot['method'];
      auth: Record<string, unknown>;
    }> = [];
    const token = envValue(
      'QODER_PERSONAL_ACCESS_TOKEN',
      'QODER_SDK_ACCESS_TOKEN',
      'QODERCN_PERSONAL_ACCESS_TOKEN',
      'QODERCN_SDK_ACCESS_TOKEN',
    );
    if (token) {
      candidates.push({
        method: 'accessToken',
        auth: { type: 'accessToken', accessToken: token },
      });
    }
    const serviceAccountKey = envValue('QODER_SERVICE_ACCOUNT_KEY', 'QODERCN_SERVICE_ACCOUNT_KEY');
    if (serviceAccountKey) {
      candidates.push({
        method: 'serviceAccount',
        auth: { type: 'serviceAccount', serviceAccountKey },
      });
    }
    // 兜底：让 daemon 复用 qodercli / IDE 的本地登录态。
    candidates.push({ method: 'qodercli', auth: { type: 'qodercli' } });
    return candidates;
  }

  private async authenticate(): Promise<void> {
    const candidates = this.authCandidates();
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const result = await this.dispatch(
          'daemon.authenticate',
          { auth: candidate.auth },
          { timeoutMs: 30000 },
        );
        if (result.authenticated === true) {
          this.auth = { method: candidate.method, authenticated: true, error: null };
          log.info(`qoder[${this.config.id}] 认证成功（${candidate.method}）`);
          return;
        }
        const hint = candidate.method === 'qodercli' ? qoderCliLoginHint() : null;
        errors.push(hint ? `qodercli: ${hint}` : `${candidate.method}: 未返回 authenticated=true`);
      } catch (error) {
        const message = (error as Error).message;
        if (
          /unknown request type|unknown method|method[_ ]?not[_ ]?found|not supported|不支持/i.test(
            message,
          )
        ) {
          // 旧版 CLI 没有 daemon.authenticate：保留兼容，不阻断启动。
          this.auth = {
            method: 'none',
            authenticated: null,
            error: `CLI 不支持 daemon.authenticate：${message}`,
          };
          log.warn(`qoder[${this.config.id}] ${this.auth.error}`);
          return;
        }
        const hint = candidate.method === 'qodercli' ? qoderCliLoginHint() : null;
        errors.push(`${candidate.method}: ${message}${hint ? `；${hint}` : ''}`);
      }
    }
    this.auth = {
      method: candidates[0]?.method ?? null,
      authenticated: false,
      error: errors.join('；') || 'qoder 认证失败',
    };
    throw new UpstreamError(this.auth.error ?? 'qoder 认证失败', {
      category: 'auth',
      retryable: false,
      status: 401,
    });
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      // daemon_keep_alive_v1：空闲期心跳，超时（约 120s）会被 daemon 判死
      if (this.child && this.state === 'ready') {
        try {
          this.writeFrame({ type: 'keep_alive' });
        } catch {
          // stdin 已断开时由 exit 监听器收尾
        }
      }
    }, KEEP_ALIVE_INTERVAL_MS);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '').trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
    if (this.stdoutBuffer.length > 64 * 1024 * 1024) {
      // 防御异常上游：缓冲失控直接掐断
      this.stdoutBuffer = '';
      this.setError('qoder 协议输出异常（超过缓冲上限）');
    }
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      log.warn(`qoder[${this.config.id}] 无法解析协议行: ${line.slice(0, 200)}`);
      return;
    }

    const type = typeof frame.type === 'string' ? frame.type : '';

    if (type === 'control_response') {
      const response =
        frame.response && typeof frame.response === 'object' && !Array.isArray(frame.response)
          ? (frame.response as Record<string, unknown>)
          : null;
      const requestId = typeof response?.request_id === 'string' ? response.request_id : '';
      const pending = requestId ? this.pending.get(requestId) : undefined;
      if (!pending) return;
      this.pending.delete(requestId);
      if (pending.timer) clearTimeout(pending.timer);
      if (response?.subtype === 'success') {
        const result =
          response.response && typeof response.response === 'object' && !Array.isArray(response.response)
            ? { ...(response.response as Record<string, unknown>) }
            : {};
        // 真实 daemon 把 open_session 的 session id 放在 control_response 帧顶层
        // （writeSuccess 的 session_id），payload 里通常没有；两种位置都接。
        const envelopeSessionId =
          typeof frame.session_id === 'string'
            ? frame.session_id
            : typeof response.session_id === 'string'
              ? response.session_id
              : '';
        if (envelopeSessionId && typeof result.session_id !== 'string') {
          result.session_id = envelopeSessionId;
        }
        pending.resolve(result);
      } else {
        // 真实协议的 error 是字符串（strict zod），旧版/兼容实现可能是对象。
        const error = response?.error;
        const message =
          typeof error === 'string'
            ? error
            : error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
              ? ((error as Record<string, unknown>).message as string)
              : typeof response?.code === 'string'
                ? `qoder 协议错误 ${requestId}: ${response.code}`
                : `qoder 协议错误 ${requestId}`;
        pending.reject(
          new UpstreamError(message, { category: 'server', retryable: false }),
        );
      }
      return;
    }

    if (type === 'control_request') {
      const requestId = typeof frame.request_id === 'string' ? frame.request_id : '';
      if (!requestId) return;
      const request =
        frame.request && typeof frame.request === 'object' && !Array.isArray(frame.request)
          ? (frame.request as Record<string, unknown>)
          : {};
      // 真实 daemon 用 request.subtype（can_use_tool / fetch_job_token 等），
      // 旧实现/兼容层可能用 request.type；两者都认。
      const requestType =
        typeof request.subtype === 'string' && request.subtype
          ? request.subtype
          : typeof request.type === 'string'
            ? request.type
            : '';
      if (!requestType) {
        this.writeInteractionError(requestId, '反向请求缺少 subtype/type');
        return;
      }
      const sessionId = typeof frame.session_id === 'string' ? frame.session_id : null;
      void this.answerInteraction({
        requestId,
        sessionId,
        type: requestType,
        payload: request,
      });
      return;
    }

    if (type === 'protocol_error') {
      log.warn(`qoder[${this.config.id}] 协议错误帧: ${line.slice(0, 300)}`);
      return;
    }

    // 会话路由消息（assistant / stream_event / result / system / status_event / ...）
    const sessionId = typeof frame.session_id === 'string' ? frame.session_id : '';
    if (sessionId) {
      const handlers = this.subscribers.get(sessionId);
      if (!handlers) return;
      const event = frame as QoderProtocolFrame;
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (error) {
          log.warn(`qoder[${this.config.id}] 事件处理失败: ${(error as Error).message}`);
        }
      }
    }
  }

  private async answerInteraction(request: QoderServerRequest): Promise<void> {
    let result: unknown = null;
    let errorMessage: string | null = null;
    try {
      if (!this.interactionHandler) {
        errorMessage = 'qoder 渠道未注册交互处理器';
      } else {
        result = await this.interactionHandler(request);
      }
    } catch (error) {
      errorMessage = (error as Error).message;
    }
    try {
      if (errorMessage) {
        this.writeInteractionError(request.requestId, errorMessage);
      } else {
        this.writeFrame({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.requestId,
            response: result ?? {},
          },
        });
      }
    } catch (error) {
      log.warn(`qoder[${this.config.id}] 应答交互失败: ${(error as Error).message}`);
    }
  }

  private writeInteractionError(requestId: string, message: string): void {
    // 真实 runtime 的 control_response error 必须是字符串（strict zod），
    // 传对象会被整帧丢弃、让 CLI 侧的反向请求悬挂。
    this.writeFrame({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: message,
      },
    });
  }

  private failPendingRequests(message: string): void {
    for (const [id, pending] of [...this.pending.entries()]) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        new UpstreamError(`qoder worker 已退出: ${message}`, {
          category: 'server',
          retryable: false,
        }),
      );
    }
  }

  private setError(message: string): void {
    this.state = 'error';
    this.lastError = message;
    log.warn(`qoder[${this.config.id}] ${message}`);
  }

  private async killChild(): Promise<void> {
    this.stopKeepAlive();
    const child = this.child;
    const pid = this.childPid;
    if (!child || !pid) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolveKill) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // ignore
          }
          resolveKill();
        }, 5000);
        killer.on('exit', () => {
          clearTimeout(timer);
          resolveKill();
        });
        killer.on('error', () => {
          clearTimeout(timer);
          try {
            child.kill();
          } catch {
            // ignore
          }
          resolveKill();
        });
      });
    } else {
      child.kill('SIGTERM');
      await sleep(500);
      if (this.child) child.kill('SIGKILL');
    }
    this.child = null;
    this.childPid = null;
  }

  logTailSnapshot(): string[] {
    return [...this.logTail.slice(-20)];
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopKeepAlive();
    this.failPendingRequests('qoder worker 正在停止');
    this.subscribers.clear();
    this.exitListeners.clear();
    // 优雅关停尽力而为：stdin 可能已断开，失败则直接 kill
    try {
      this.writeFrame({ type: 'control_request', request_id: `c2a-${randomId()}`, request: { type: 'daemon.shutdown' } });
    } catch {
      // ignore
    }
    await this.killChild();
    this.state = 'stopped';
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 把 daemon.get_models 的原始条目归一化成面板可用结构。
 * 字段缺失 / 类型漂移一律降级（不抛错），否则一次 CLI 升级就会让整个模型目录不可用。
 */
export function normalizeQoderModels(raw: unknown): QoderModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const models: QoderModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.isEnabled === false) continue;
    const id = textOf(record.modelId) || textOf(record.value) || textOf(record.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const efforts = Array.isArray(record.efforts)
      ? record.efforts
          .filter((effort): effort is string => typeof effort === 'string' && Boolean(effort.trim()))
          .map((effort) => effort.trim())
      : [];
    models.push({
      id,
      displayName: textOf(record.displayName) || id,
      description: textOf(record.description),
      contextWindow: positiveInt(record.maxInputTokens),
      maxOutputTokens: positiveInt(record.maxOutputTokens),
      reasoning: record.isReasoning === true,
      vision: record.isVl === true,
      isDefault: record.isDefault === true,
      efforts: efforts.length > 0 ? efforts : undefined,
      priceFactor:
        typeof record.priceFactor === 'number' && Number.isFinite(record.priceFactor)
          ? record.priceFactor
          : undefined,
    });
  }
  return models;
}

let idCounter = 0;
function randomId(): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${idCounter}`;
}
