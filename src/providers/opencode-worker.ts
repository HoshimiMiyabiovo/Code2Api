import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { OpenCodeProviderConfig } from '../config.js';
import { UpstreamError } from '../errors.js';
import { log } from '../logger.js';

export interface OpenCodeEvent {
  id?: string;
  type: string;
  created?: number;
  data: Record<string, any>;
}

export type WorkerState = 'idle' | 'starting' | 'ready' | 'restarting' | 'error' | 'stopped';

export interface WorkerSnapshot {
  state: WorkerState;
  mode: 'spawn' | 'external';
  baseUrl: string | null;
  pid: number | null;
  port: number | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
  workspace: string | null;
  rssMb: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function findFreePort(hostname: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolvePort(address.port));
    });
  });
}

function mapApiError(status: number, message: string): UpstreamError {
  if (status === 401 || status === 403) {
    return new UpstreamError(message, { category: 'auth', status, retryable: false });
  }
  if (status === 404) {
    return new UpstreamError(message, { category: 'model_not_found', status, retryable: false });
  }
  if (status === 409) {
    return new UpstreamError(message, { category: 'busy', status, retryable: false });
  }
  if (status === 429) {
    return new UpstreamError(message, { category: 'rate_limit', status, retryable: true });
  }
  if (status >= 500) {
    return new UpstreamError(message, { category: 'server', status, retryable: true });
  }
  return new UpstreamError(message, { category: 'bad_request', status, retryable: false });
}

export class OpenCodeWorker {
  private child: ChildProcess | null = null;
  private childPid: number | null = null;
  private remotePid: number | null = null;
  private rssMb: number | null = null;
  private rssTimer: NodeJS.Timeout | null = null;
  private port: number | null = null;
  private baseUrl: string | null = null;
  private authorization: string | null = null;
  private state: WorkerState = 'idle';
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private eventAbort: AbortController | null = null;
  private eventLoopRunning = false;
  private eventConnected = false;
  private eventWaiters: Array<() => void> = [];
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private readonly subscribers = new Map<string, Set<(event: OpenCodeEvent) => void>>();
  private readonly logTail: string[] = [];
  private readonly passwordEnv: string;
  private readonly externalMode: boolean;

  constructor(private readonly config: OpenCodeProviderConfig) {
    this.passwordEnv = config.passwordEnv;
    this.externalMode = Boolean(config.baseUrl);
    if (config.baseUrl) {
      this.baseUrl = config.baseUrl.replace(/\/+$/, '');
      const password = process.env[this.passwordEnv] ?? '';
      this.authorization = password
        ? 'Basic ' + Buffer.from(`${config.username}:${password}`).toString('base64')
        : null;
    }
  }

  snapshot(): WorkerSnapshot {
    return {
      state: this.state,
      mode: this.externalMode ? 'external' : 'spawn',
      baseUrl: this.baseUrl,
      pid: this.childPid,
      port: this.port,
      restarts: this.restarts,
      lastError: this.lastError,
      startedAt: this.startedAt,
      workspace: this.externalMode ? null : resolve(process.cwd(), this.config.workspace),
      rssMb: this.rssMb,
    };
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  private setError(message: string): void {
    this.state = 'error';
    this.lastError = message;
    log.warn(`opencode[${this.config.id}] ${message}`);
  }

  async ensureStarted(): Promise<void> {
    if (this.stopping) {
      throw new UpstreamError('opencode worker 已停止', { category: 'server', retryable: false });
    }
    if (this.state === 'ready') return;
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  private async startInternal(): Promise<void> {
    if (this.externalMode) {
      this.state = 'starting';
      try {
        await this.waitReady();
        this.state = 'ready';
        this.startedAt = Date.now();
        this.startEventLoop();
        this.startRssSampling();
        log.info(`opencode[${this.config.id}] 已连接外部服务 ${this.baseUrl}`);
      } catch (error) {
        this.setError(`连接外部 opencode 失败: ${(error as Error).message}`);
        throw error;
      }
      return;
    }

    this.state = 'starting';
    const hostname = this.config.hostname;
    const port = this.config.port ?? (await findFreePort(hostname));
    const workspace = resolve(process.cwd(), this.config.workspace);
    mkdirSync(workspace, { recursive: true });
    const password = randomBytes(24).toString('base64url');
    this.authorization =
      'Basic ' + Buffer.from(`${this.config.username}:${password}`).toString('base64');
    this.port = port;
    this.baseUrl = `http://${hostname}:${port}`;

    const args = [
      'serve',
      '--hostname',
      hostname,
      '--port',
      String(port),
      ...this.config.args,
    ];
    log.info(`opencode[${this.config.id}] 启动: ${this.config.command} ${args.join(' ')}`);
    let child: ChildProcess;
    try {
      child = spawn(this.config.command, args, {
        cwd: workspace,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_SERVER_USERNAME: this.config.username,
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.setError(`无法启动 opencode: ${(error as Error).message}`);
      throw new UpstreamError(this.lastError ?? '无法启动 opencode', {
        category: 'server',
        retryable: false,
      });
    }
    this.child = child;
    this.childPid = child.pid ?? null;
    const capture = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logTail.push(line);
        if (this.logTail.length > 80) this.logTail.shift();
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', (error) => {
      this.lastError = error.message;
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      this.childPid = null;
      this.eventAbort?.abort();
      if (this.stopping) {
        this.state = 'stopped';
        return;
      }
      this.setError(`opencode 进程退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`);
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
      this.setError(`opencode 启动超时或不可用: ${(error as Error).message}`);
      throw error;
    }
    this.state = 'ready';
    this.startedAt = Date.now();
    this.lastError = null;
    this.startEventLoop();
    this.startRssSampling();
    log.info(`opencode[${this.config.id}] 就绪: ${this.baseUrl}`);
  }

  private async waitReady(): Promise<void> {
    if (!this.baseUrl) throw new Error('baseUrl 未初始化');
    const deadline = Date.now() + this.config.startupTimeoutMs;
    let lastMessage = 'no response';
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error('worker stopped');
      try {
        const info = await this.api<{ pid?: number }>('GET', '/api/info');
        if (typeof info?.pid === 'number') this.remotePid = info.pid;
        return;
      } catch (error) {
        lastMessage = (error as Error).message;
        await sleep(300);
      }
    }
    throw new Error(lastMessage);
  }

  private startRssSampling(): void {
    if (this.rssTimer) return;
    void this.sampleRss();
    this.rssTimer = setInterval(() => {
      void this.sampleRss();
    }, 30000);
    this.rssTimer.unref?.();
  }

  private async sampleRss(): Promise<void> {
    const pid = this.childPid ?? this.remotePid;
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        const output = await new Promise<string>((resolveExec, rejectExec) => {
          execFile(
            'tasklist',
            ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
            { windowsHide: true, timeout: 5000 },
            (error, stdout) => {
              if (error) rejectExec(error);
              else resolveExec(stdout);
            },
          );
        });
        const line = output.trim().split(/\r?\n/)[0] ?? '';
        const columns = line
          .split('","')
          .map((value) => value.replace(/^"|"$/g, ''));
        const memory = columns[4] ?? '';
        const kb = Number(memory.replace(/[^\d]/g, ''));
        if (Number.isFinite(kb) && kb > 0) {
          this.rssMb = Math.round((kb / 1024) * 10) / 10;
        }
      } else {
        const output = await new Promise<string>((resolveExec, rejectExec) => {
          execFile(
            'ps',
            ['-o', 'rss=', '-p', String(pid)],
            { timeout: 5000 },
            (error, stdout) => {
              if (error) rejectExec(error);
              else resolveExec(stdout);
            },
          );
        });
        const kb = Number(output.trim());
        if (Number.isFinite(kb) && kb > 0) {
          this.rssMb = Math.round((kb / 1024) * 10) / 10;
        }
      }
    } catch {
      // ignore sampling failures
    }
  }

  private headers(hasBody: boolean): Record<string, string> {
    return {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(this.authorization ? { authorization: this.authorization } : {}),
    };
  }

  async api<T = any>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new UpstreamError('opencode 尚未启动', { category: 'server', retryable: true });
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new UpstreamError('client aborted', { category: 'cancelled', retryable: false });
      }
      throw new UpstreamError(`opencode 请求失败: ${(error as Error).message}`, {
        category: 'network',
        retryable: true,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw mapApiError(
        response.status,
        `opencode HTTP ${response.status}: ${text.slice(0, 300) || response.statusText}`,
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UpstreamError('opencode 返回了非 JSON 响应', {
        category: 'server',
        retryable: true,
        bodySnippet: text.slice(0, 500),
      });
    }
  }

  subscribeSession(
    sessionId: string,
    handler: (event: OpenCodeEvent) => void,
  ): () => void {    let set = this.subscribers.get(sessionId);
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

  private sessionIdOf(event: OpenCodeEvent): string | null {
    const data = event.data ?? {};
    const candidates = [
      data.sessionID,
      data.form?.sessionID,
      data.request?.sessionID,
      data.message?.sessionID,
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value) return value;
    }
    return null;
  }

  private dispatch(event: OpenCodeEvent): void {
    const sessionId = this.sessionIdOf(event);
    if (!sessionId) return;
    const handlers = this.subscribers.get(sessionId);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (error) {
        log.warn(`opencode 事件处理出错: ${(error as Error).message}`);
      }
    }
  }

  private startEventLoop(): void {
    if (this.eventLoopRunning || this.stopping || !this.baseUrl) return;
    this.eventLoopRunning = true;
    const controller = new AbortController();
    this.eventAbort = controller;
    void this.runEventLoop(controller).finally(() => {
      this.eventLoopRunning = false;
      this.eventConnected = false;
      if (!this.stopping) {
        setTimeout(() => this.startEventLoop(), 1000);
      }
    });
  }

  async waitEventStream(timeoutMs = 5000): Promise<void> {
    if (this.eventConnected) return;
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(onReady);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(
          new UpstreamError('opencode 事件流未就绪', {
            category: 'timeout',
            retryable: true,
          }),
        );
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolveWait();
      };
      this.eventWaiters.push(onReady);
    });
  }

  private async runEventLoop(controller: AbortController): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/event`, {
        headers: this.headers(false),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`event stream HTTP ${response.status}`);
      }
      this.eventConnected = true;
      const waiters = this.eventWaiters.splice(0);
      for (const waiter of waiters) waiter();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            if (raw) {
              try {
                const event = JSON.parse(raw) as OpenCodeEvent;
                if (event && typeof event.type === 'string') this.dispatch(event);
              } catch {
                // ignore malformed events
              }
            }
          }
          index = buffer.indexOf('\n');
        }
      }
      log.warn(`opencode[${this.config.id}] 事件流结束`);
    } catch (error) {
      if (!controller.signal.aborted) {
        log.warn(`opencode[${this.config.id}] 事件流中断: ${(error as Error).message}`);
      }
    }
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

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.rssTimer) {
      clearInterval(this.rssTimer);
      this.rssTimer = null;
    }
    this.eventAbort?.abort();
    this.eventAbort = null;
    this.eventConnected = false;
    this.eventWaiters.splice(0);
    if (!this.externalMode) {
      await this.killChild();
    }
    this.subscribers.clear();
    this.state = 'stopped';
  }
}
