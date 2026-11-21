import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ZcodeProviderConfig } from '../config.js';
import { UpstreamError } from '../errors.js';
import { log } from '../logger.js';

export type ZcodeWorkerState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'error'
  | 'stopped';

export interface ZcodeWorkerSnapshot {
  state: ZcodeWorkerState;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
  workspace: string | null;
  /** 子进程 stderr 尾部（排障用），经 admin API 透出。 */
  logTail: string[];
}

/** session/event 通知的 params。 */
export interface ZcodeProtocolEvent {
  eventId?: string;
  sessionId?: string;
  seq?: number;
  timestamp?: number;
  traceId?: string;
  type: string;
  payload?: Record<string, unknown>;
}

/** 服务端反向请求（如 interaction/requestPermission），需要客户端应答。 */
export interface ZcodeServerRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export class ZcodeWorker {
  private child: ChildProcess | null = null;
  private childPid: number | null = null;
  private state: ZcodeWorkerState = 'idle';
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscribers = new Map<
    string,
    Set<(event: ZcodeProtocolEvent) => void>
  >();
  private readonly exitListeners = new Set<(message: string) => void>();
  private interactionHandler:
    | ((request: ZcodeServerRequest) => Promise<unknown> | unknown)
    | null = null;
  private readonly logTail: string[] = [];
  private stdoutBuffer = '';

  constructor(private readonly config: ZcodeProviderConfig) {}

  snapshot(): ZcodeWorkerSnapshot {
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
    handler: (request: ZcodeServerRequest) => Promise<unknown> | unknown,
  ): void {
    this.interactionHandler = handler;
  }

  onExit(listener: (message: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  subscribeSession(
    sessionId: string,
    handler: (event: ZcodeProtocolEvent) => void,
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
      throw new UpstreamError('zcode worker 已停止', { category: 'server', retryable: false });
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
   * 发起一次协议请求并等待应答。
   * 任一应答帧（result 或 error）都证明协议存活；error 帧转 UpstreamError。
   */
  async request<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 60000,
  ): Promise<T> {
    if (!this.child || this.state !== 'ready') {
      throw new UpstreamError('zcode worker 未就绪', { category: 'server', retryable: false });
    }
    const id = `c2a-${this.nextRequestId++}`;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const pending: PendingRequest = {
        resolve: resolveRequest as (value: Record<string, unknown>) => void,
        reject: rejectRequest,
        timer: null,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          rejectRequest(
            new UpstreamError(`zcode 协议请求 ${method} 超时（${timeoutMs}ms）`, {
              category: 'timeout',
            }),
          );
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      this.writeFrame({ id, method, ...(params ? { params } : {}) });
    });
  }

  private writeFrame(frame: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin) {
      throw new UpstreamError('zcode worker stdin 不可用', { category: 'server' });
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
    const baseArgs = this.config.args.includes('app-server')
      ? [...this.config.args]
      : [...this.config.args, 'app-server'];
    log.info(
      `zcode[${this.config.id}] 启动: ${this.config.command} ${baseArgs.join(' ')}`,
    );
    let child: ChildProcess;
    try {
      child = spawn(this.config.command, baseArgs, {
        cwd: workspace,
        env: { ...process.env, ...this.config.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.setError(`无法启动 zcode: ${(error as Error).message}`);
      throw new UpstreamError(this.lastError ?? '无法启动 zcode', {
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
      const message = `zcode 进程退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      this.child = null;
      this.childPid = null;
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
      this.setError(`zcode 启动超时或不可用: ${(error as Error).message}`);
      throw error;
    }
    this.state = 'ready';
    this.startedAt = Date.now();
    this.lastError = null;
    log.info(`zcode[${this.config.id}] 就绪 (pid ${this.childPid ?? '?'})`);
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + this.config.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) {
        throw new Error(this.lastError ?? 'zcode 进程已退出');
      }
      try {
        await this.request('session/list', { limit: 1 }, 5000);
        return;
      } catch (error) {
        // 进程已死：立即失败，保留退出原因（否则会被下面的“协议存活”逻辑误判为就绪）
        if (!this.child) {
          throw new Error(this.lastError ?? 'zcode 进程已退出');
        }
        // 协议层能应答（哪怕是参数错误帧）即视为就绪；超时/网络类错误则重试。
        if (
          error instanceof UpstreamError &&
          error.category !== 'timeout' &&
          error.category !== 'network'
        ) {
          return;
        }
        await sleep(300);
      }
    }
    throw new Error(`zcode app-server 未在 ${this.config.startupTimeoutMs}ms 内就绪`);
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
      this.setError('zcode 协议输出异常（超过缓冲上限）');
    }
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      log.warn(`zcode[${this.config.id}] 无法解析协议行: ${line.slice(0, 200)}`);
      return;
    }

    const hasResult = 'result' in frame || 'error' in frame;
    const id = frame.id;
    if (hasResult && (typeof id === 'string' || typeof id === 'number')) {
      const key = String(id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      if ('error' in frame) {
        const error = frame.error as Record<string, unknown> | undefined;
        const message =
          typeof error?.message === 'string' ? error.message : `zcode 协议错误 ${key}`;
        pending.reject(
          new UpstreamError(message, { category: 'server', retryable: false }),
        );
      } else {
        const result = frame.result;
        pending.resolve(
          result && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : {},
        );
      }
      return;
    }

    const method = typeof frame.method === 'string' ? frame.method : '';
    if (!method) return;
    const params =
      frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params)
        ? (frame.params as Record<string, unknown>)
        : {};

    if (typeof id === 'string' || typeof id === 'number') {
      // 服务端反向请求，需要应答
      void this.answerInteraction(String(id), method, params);
      return;
    }

    if (method === 'session/event') {
      const event = params as unknown as ZcodeProtocolEvent;
      const sessionId = typeof event?.sessionId === 'string' ? event.sessionId : '';
      if (!sessionId) return;
      const handlers = this.subscribers.get(sessionId);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (error) {
          log.warn(`zcode[${this.config.id}] 事件处理失败: ${(error as Error).message}`);
        }
      }
      return;
    }
    // state.updated 等其他通知暂不处理
  }

  private async answerInteraction(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    let result: unknown = null;
    let errorMessage: string | null = null;
    try {
      if (!this.interactionHandler) {
        errorMessage = 'zcode 渠道未注册交互处理器';
      } else {
        result = await this.interactionHandler({ id, method, params });
      }
    } catch (error) {
      errorMessage = (error as Error).message;
    }
    try {
      if (errorMessage) {
        this.writeFrame({
          id,
          error: { code: -32603, message: errorMessage },
        });
      } else {
        this.writeFrame({ id, result: result ?? {} });
      }
    } catch (error) {
      log.warn(`zcode[${this.config.id}] 应答交互失败: ${(error as Error).message}`);
    }
  }

  private failPendingRequests(message: string): void {
    for (const [id, pending] of [...this.pending.entries()]) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        new UpstreamError(`zcode worker 已退出: ${message}`, {
          category: 'server',
          retryable: false,
        }),
      );
    }
  }

  private setError(message: string): void {
    this.state = 'error';
    this.lastError = message;
    log.warn(`zcode[${this.config.id}] ${message}`);
  }

  private async killChild(): Promise<void> {
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
    this.failPendingRequests('zcode worker 正在停止');
    this.subscribers.clear();
    this.exitListeners.clear();
    await this.killChild();
    this.state = 'stopped';
  }
}
