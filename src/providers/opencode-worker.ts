import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { OpenCodeProviderConfig } from '../config.js';
import { UpstreamError } from '../errors.js';
import { log } from '../logger.js';
import { defaultCodeArtsDataDir, resolveCodeArtsEndpoint } from './codearts-discovery.js';

export interface OpenCodeEvent {
  id?: string;
  type: string;
  created?: number;
  data: Record<string, any>;
}

const SESSION_ID_KEYS = ['sessionID', 'sessionId', 'session_id'] as const;
const SESSION_CONTAINER_KEYS = [
  'data',
  'properties',
  'payload',
  'info',
  'part',
  'message',
  'session',
  'request',
  'form',
  'params',
] as const;

/** 上游事件里可能出现的敏感键：debug 日志必须脱敏，不能把 IDE 口令/令牌打进日志。 */
const SENSITIVE_KEY =
  /^(authorization|password|passwd|secret|token|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|api[_-]?key|apikey|cookie|set-cookie)$/i;

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

/**
 * 统一事件负载格式（多方言兼容）：
 * - 原版 / kilo 的 SSE 是 {type, data}；
 * - CodeArts IDE 内核（v126.11.1 实测）是 {type, properties}，没有 data；
 * - 部分 IDE 版本再套一层信封：{directory, payload:{type, properties}}；
 * - sessionID 可能出现在 data/properties 顶层，也可能嵌在 info/part/message/session 里。
 * 若不做归一化，dispatch 取不到 sessionID，所有事件都会被静默丢弃，流式请求一直等到客户端超时。
 */
export function normalizeEvent(raw: unknown): OpenCodeEvent | null {
  const initial = asRecord(raw);
  if (!initial) return null;
  let node: Record<string, any> = initial;
  const hasType = (value: Record<string, any>) =>
    typeof value.type === 'string' || typeof value.event === 'string';
  // 逐层剥开 {directory, payload: {...}} 信封，最多 3 层，防止异常负载死循环。
  const ancestors: Record<string, any>[] = [];
  let depth = 0;
  while (!hasType(node) && depth < 3) {
    ancestors.push(node);
    const next: Record<string, any> | null =
      asRecord(node.payload) ?? asRecord(node.event);
    if (!next) return null;
    node = next;
    depth += 1;
  }
  const type =
    typeof node.type === 'string'
      ? node.type
      : typeof node.event === 'string'
        ? node.event
        : '';
  if (!type) return null;

  const data: Record<string, any> = {};
  const merge = (value: unknown) => {
    const rec = asRecord(value);
    if (rec) Object.assign(data, rec);
  };
  // 内层 properties 先铺底，data 后覆盖（与原版 {type,data} 语义一致）。
  merge(node.properties);
  const nested = asRecord(node.payload);
  if (nested) {
    merge(nested.properties);
    merge(nested.data);
    if (
      !asRecord(nested.properties) &&
      !asRecord(nested.data) &&
      !hasType(nested)
    ) {
      merge(nested);
    }
  }
  merge(node.data);
  // 信封/顶层上的 directory、sessionID 也并进 data，供工作区与订阅匹配使用。
  ancestors.push(node);
  for (const ancestor of ancestors) {
    if (typeof ancestor.directory === 'string' && typeof data.directory !== 'string') {
      data.directory = ancestor.directory;
    }
    for (const key of SESSION_ID_KEYS) {
      if (typeof ancestor[key] === 'string' && typeof data[key] !== 'string') {
        data[key] = ancestor[key];
      }
    }
  }
  const id = typeof node.id === 'string' ? node.id : undefined;
  const created = typeof node.created === 'number' ? node.created : undefined;
  return { type, data, ...(id ? { id } : {}), ...(created ? { created } : {}) };
}

/** 从已归一化的事件中提取 sessionID（兼容顶层与常见嵌套容器）。 */
export function sessionIdOfEvent(event: OpenCodeEvent): string | null {
  return findSessionId(event.data, 0);
}

function findSessionId(value: unknown, depth: number): string | null {
  if (depth > 4) return null;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of SESSION_ID_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  for (const key of SESSION_CONTAINER_KEYS) {
    const found = findSessionId(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function redactForLog(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > 240 ? `${value.slice(0, 240)}…(${value.length} chars)` : value;
  }
  if (depth > 6) return '…';
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => redactForLog(item, depth + 1));
    if (value.length > 50) items.push(`…(${value.length} items)`);
    return items;
  }
  const record = asRecord(value);
  if (!record) return value;
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(record)) {
    count += 1;
    if (count > 80) {
      out['…'] = 'truncated';
      break;
    }
    out[key] = SENSITIVE_KEY.test(key) ? '***' : redactForLog(item, depth + 1);
  }
  return out;
}

/**
 * 把 /event 原始帧变成单行、可读、脱敏且限长的 debug 文本。
 * JSON 解析成功时按结构脱敏；解析失败时退回正则掩码。
 */
export function sanitizeEventFrame(raw: string, limit = 1200): string {
  let text: string;
  try {
    text = JSON.stringify(redactForLog(JSON.parse(raw), 0));
  } catch {
    text = raw
      .replace(
        /("?(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)"?\s*[:=]\s*")([^"]*)(")/gi,
        '$1***$3',
      )
      .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > limit) {
    text = `${text.slice(0, limit)}…(${text.length} chars)`;
  }
  return text || '(empty)';
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
  /** 当前 /event 连接已收到的数据帧数（每次重连重置）。 */
  private eventFrames = 0;
  /** 当前 /event 连接因解析/归一化/订阅原因丢弃的帧数。 */
  private eventDrops = 0;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private readonly subscribers = new Map<string, Set<(event: OpenCodeEvent) => void>>();
  private readonly logTail: string[] = [];
  private readonly passwordEnv: string;
  private readonly externalMode: boolean;

  constructor(private readonly config: OpenCodeProviderConfig) {
    this.passwordEnv = config.passwordEnv;
    // codearts 风味固定外部模式：连接 CodeArts IDE 已拉起的内核服务，
    // 端口与口令在启动时从 IDE 数据目录发现/解密（IDE 重启后会变化，重新发现）。
    this.externalMode = Boolean(config.baseUrl) || config.flavor === 'codearts';
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
        if (this.config.flavor === 'codearts' && !this.config.baseUrl) {
          const dataDir = this.config.codeartsDataDir ?? defaultCodeArtsDataDir();
          const endpoint = resolveCodeArtsEndpoint(dataDir);
          if (!endpoint) {
            throw new Error(
              `未发现 CodeArts IDE 内核服务（数据目录 ${dataDir}）；请先打开 CodeArts Agent IDE 并登录`,
            );
          }
          this.baseUrl = endpoint.baseUrl;
          this.remotePid = endpoint.pid;
          this.authorization =
            'Basic ' + Buffer.from(`codearts:${endpoint.password}`).toString('base64');
        }
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
          ...this.config.env,
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
    // kilo（KiloDesktop 内置 opencode fork，v7.8.27 实测）没有 /api/info，
    // 用 /config 判就绪；pid 仅原版 /api/info 提供，kilo 下 RSS 采样自动跳过。
    // codearts（IDE 内核，旧版 opencode API）：/config 存在且无 /api 前缀。
    const probePath =
      this.config.flavor === 'kilo' || this.config.flavor === 'codearts'
        ? '/config'
        : '/api/info';
    const deadline = Date.now() + this.config.startupTimeoutMs;
    let lastMessage = 'no response';
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error('worker stopped');
      try {
        const info = await this.api<{ pid?: number }>('GET', probePath);
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
    // codearts（IDE 内核，旧版 opencode API）：路由无 /api 前缀，统一在此剥掉，
    // 适配器层保持与原版一致的路径写法。
    const effectivePath =
      this.config.flavor === 'codearts' && path.startsWith('/api/')
        ? path.slice(4)
        : path;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${effectivePath}`, {
        method,
        headers: {
          ...this.headers(body !== undefined),
          // 旧版服务器对未知路径回退 SPA HTML；显式 Accept 让 API 路由返回 JSON。
          accept: 'application/json',
        },
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

  private sessionIdOf(event: OpenCodeEvent): string | null {
    return sessionIdOfEvent(event);
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

  /** 丢弃原因只在 debug 级别打印（/event 是全局流，其他会话的事件无订阅者属正常现象）。 */
  private noteEventDrop(frame: number, reason: string, raw: string): void {
    this.eventDrops += 1;
    if (this.eventDrops <= 50 || this.eventDrops % 50 === 0) {
      log.debug(
        `opencode[${this.config.id}] /event 丢弃帧 #${frame}：${reason} | ${sanitizeEventFrame(raw)}`,
      );
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
      // codearts 旧版 API 事件流无 /api 前缀。
      const eventPath = this.config.flavor === 'codearts' ? '/event' : '/api/event';
      const response = await fetch(`${this.baseUrl}${eventPath}`, {
        headers: this.headers(false),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`event stream HTTP ${response.status}`);
      }
      this.eventConnected = true;
      const waiters = this.eventWaiters.splice(0);
      for (const waiter of waiters) waiter();
      this.eventFrames = 0;
      this.eventDrops = 0;
      log.debug(
        `opencode[${this.config.id}] ${eventPath} 已连接：前 ${this.config.eventDebugFrames} 帧以 debug 打印（已脱敏）`,
      );
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
              this.eventFrames += 1;
              const frame = this.eventFrames;
              if (frame <= this.config.eventDebugFrames) {
                log.debug(
                  `opencode[${this.config.id}] /event 原始帧 #${frame} ${sanitizeEventFrame(raw)}`,
                );
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch {
                this.noteEventDrop(frame, 'JSON 解析失败', raw);
                index = buffer.indexOf('\n');
                continue;
              }
              const event = normalizeEvent(parsed);
              if (!event) {
                this.noteEventDrop(frame, '未识别事件形态（缺少 type/payload）', raw);
                index = buffer.indexOf('\n');
                continue;
              }
              const sessionId = this.sessionIdOf(event);
              if (!sessionId) {
                this.noteEventDrop(frame, `type=${event.type} 未提取到 sessionID`, raw);
                index = buffer.indexOf('\n');
                continue;
              }
              if (!this.subscribers.has(sessionId)) {
                this.noteEventDrop(frame, `sessionID=${sessionId} 无订阅者`, raw);
                index = buffer.indexOf('\n');
                continue;
              }
              this.dispatch(event);
            }
          }
          index = buffer.indexOf('\n');
        }
      }
      log.warn(
        `opencode[${this.config.id}] 事件流结束（收到 ${this.eventFrames} 帧，丢弃 ${this.eventDrops} 帧）`,
      );
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
