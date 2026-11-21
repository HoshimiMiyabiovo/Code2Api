import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QoderProviderConfig } from '../config.js';
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
      child = spawn(this.config.command, baseArgs, {
        cwd: workspace,
        env: {
          ...process.env,
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
    const deadline = Date.now() + this.config.startupTimeoutMs;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      if (!this.child) {
        throw new Error(this.lastError ?? 'qoder 进程已退出');
      }
      try {
        await this.dispatch(
          'daemon.initialize',
          {
            daemon_protocol_version: DAEMON_PROTOCOL_VERSION,
            sdk_version: 'code2api-gateway',
            capabilities: ['multi_session_v2', 'session_delete_v1', 'daemon_queries_v1'],
          },
          { timeoutMs: 8000 },
        );
        return;
      } catch (error) {
        if (!this.child) {
          throw new Error(this.lastError ?? 'qoder 进程已退出');
        }
        lastError = error as Error;
        // 超时可能是 CLI 还在初始化：重试直到 startupTimeoutMs；
        // 其余（含协议 error 应答：认证失败/版本不支持等）直接判启动失败，保留诊断信息。
        if (
          !(error instanceof UpstreamError) ||
          error.category !== 'timeout'
        ) {
          throw error;
        }
        await sleep(300);
      }
    }
    throw new Error(
      lastError
        ? `qoder daemon 未在 ${this.config.startupTimeoutMs}ms 内就绪: ${lastError.message}`
        : `qoder daemon 未在 ${this.config.startupTimeoutMs}ms 内就绪`,
    );
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
            ? (response.response as Record<string, unknown>)
            : {};
        pending.resolve(result);
      } else {
        const error = response?.error;
        const message =
          typeof error === 'string'
            ? error
            : error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
              ? ((error as Record<string, unknown>).message as string)
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
      const requestType = typeof request.type === 'string' ? request.type : '';
      if (!requestType) {
        this.writeInteractionError(requestId, '反向请求缺少 type');
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
    this.writeFrame({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: { message },
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

let idCounter = 0;
function randomId(): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${idCounter}`;
}
