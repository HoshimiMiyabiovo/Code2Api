import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  textOf,
  type CanonicalRequest,
  type CanonicalResponse,
  type StopReason,
  type StreamEvent,
  type Usage,
} from '../canonical.js';
import type { ModelConfig, OpenCodeProviderConfig } from '../config.js';
import { matchesGlob } from '../core/model-rules.js';
import { GatewayError, UpstreamError } from '../errors.js';
import { log } from '../logger.js';
import type { OcQuestionRow, Store } from '../store/db.js';
import {
  OpenCodeWorker,
  type OpenCodeEvent,
  type WorkerSnapshot,
} from './opencode-worker.js';
import type { ChatContext, ProviderAdapter } from './types.js';

type TaskOutcome = 'succeeded' | 'failed' | 'interrupted' | 'first_byte_timeout';

interface TaskRuntime {
  taskId: string;
  worker: OpenCodeWorker;
  gatewaySessionId: string;
  ocSessionId: string;
  oneShot: boolean;
  startTime: number;
  text: string;
  thinking: string;
  finish: StopReason;
  usage: Usage;
  /** 最后一个内部 step 的用量 = 客户端可见的「当前对话规模」（usage 字段语义）。 */
  lastStepUsage: Usage | null;
  steps: number;
  lastError: string | null;
  suspended: boolean;
  pendingQuestionIds: Set<string>;
  /** kilo fork：message.part.updated 以 part 累积全文推送，记录每个 part 已交付长度用于差分。 */
  partTexts: Map<string, number>;
  /** 挂起等待用户输入期间的 SSE 心跳定时器（防止客户端空闲超时掐断连接）。 */
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  /** 已收到的上游事件数：用于诊断日志。 */
  eventsSeen: number;
  /** 是否已收到「真正代表模型开始处理」的事件（用户消息回显不算）。 */
  sawProgress: boolean;
  /** 最近一次上游事件时间：静默超过心跳间隔时向客户端发 SSE 注释帧保活。 */
  lastEventAt: number;
  /** 首包等待/静默期心跳。 */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /** 首包预算定时器；收到第一个事件后清空。 */
  firstByteTimer: ReturnType<typeof setTimeout> | null;
  /** kilo fork：messageID → role；part 更新对 user 消息也会发，必须只透传 assistant 的。 */
  messageRoles: Map<string, string>;
}

interface PendingQuestion {
  id: string;
  kind: 'form' | 'permission';
  requestId: string;
  runtime: TaskRuntime;
  payload: unknown;
  createdAt: number;
  timer: NodeJS.Timeout | null;
  resolveOutcome: (outcome: TaskOutcome) => void;
}

export interface PendingQuestionView {
  id: string;
  providerId: string;
  gatewaySessionId: string;
  ocSessionId: string;
  kind: 'form' | 'permission';
  payload: unknown;
  createdAt: number;
}

interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

function parseModelRef(
  model: ModelConfig,
  reasoningEffort?: string,
  flavor: 'opencode' | 'kilo' | 'codearts' = 'opencode',
): ModelRef {
  const index = model.upstream.indexOf('/');
  if (index <= 0 || index === model.upstream.length - 1) {
    throw new UpstreamError(
      `opencode 模型 ${model.id} 的 upstream 必须是 providerID/modelID，例如 opencode/iceman-free`,
      { category: 'bad_request', retryable: false },
    );
  }
  let variant: string | undefined;
  if (reasoningEffort) {
    variant = model.reasoningVariants?.[reasoningEffort];
    // kilo fork 的 /api/model 恒返回空 variants 数组，档位不在模型目录里；
    // 但会话级 model.variant 接受 effort 枚举值并原样生效（实测回显），
    // 未指定时服务端填 "default"（非思考）。
    if (!variant && flavor === 'kilo') {
      variant = reasoningEffort.toLowerCase();
    }
  }
  return {
    providerID: model.upstream.slice(0, index),
    id: model.upstream.slice(index + 1),
    ...(variant ? { variant } : {}),
  };
}

export function normalizePathForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function realDirectory(value: string): string | null {
  try {
    const real = realpathSync.native(value);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function resolveWorkspace(raw: string, roots: string[]): string {
  if (!isAbsolute(raw)) {
    throw new UpstreamError(`工作区必须是绝对路径: ${raw}`, {
      category: 'bad_request',
      status: 400,
      retryable: false,
    });
  }
  const candidate = realDirectory(raw);
  if (!candidate) {
    throw new UpstreamError(`工作区不存在或不是目录: ${raw}`, {
      category: 'bad_request',
      status: 400,
      retryable: false,
    });
  }
  const normalized = normalizePathForCompare(candidate);
  const allowed = roots.some((root) => {
    const realRoot = realDirectory(resolve(process.cwd(), root));
    if (!realRoot) return false;
    const rel = relative(normalizePathForCompare(realRoot), normalized);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!allowed) {
    throw new UpstreamError(`工作区不在允许的根目录内: ${candidate}`, {
      category: 'bad_request',
      status: 400,
      retryable: false,
    });
  }
  return candidate;
}

function mapFinish(reason: unknown): StopReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool-calls':
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content-filter':
    case 'content_filter':
      return 'content_filter';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

function toolEventText(event: OpenCodeEvent): string | null {
  const data = event.data ?? {};
  const name = String(data.name ?? data.tool ?? data.id ?? 'tool');
  if (event.type === 'session.tool.called') {
    const raw = data.input ?? data.args ?? data.arguments;
    let args = '';
    if (typeof raw === 'string') args = raw;
    else if (raw && typeof raw === 'object') {
      try {
        args = JSON.stringify(raw);
      } catch {
        args = '';
      }
    }
    args = args.replace(/\s+/g, ' ').trim();
    if (args.length > 160) args = `${args.slice(0, 157)}...`;
    return `[工具] ${name} 调用${args ? `: ${args}` : ''}\n`;
  }
  if (event.type === 'session.tool.success') {
    return `[工具] ${name} 完成\n`;
  }
  if (event.type === 'session.tool.failed') {
    const message = String(data.error ?? data.message ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    return `[工具] ${name} 失败${message ? `: ${message}` : ''}\n`;
  }
  return null;
}

function eventError(event: OpenCodeEvent): string {
  const data = event.data ?? {};
  const error = data.error ?? data.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const rec = error as Record<string, unknown>;
    if (typeof rec.message === 'string') return rec.message;
    if (typeof rec.name === 'string') return rec.name;
    return JSON.stringify(error).slice(0, 500);
  }
  return event.type;
}

export class EventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private rejecters: Array<(error: unknown) => void> = [];
  private done = false;
  private error: unknown = null;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    for (const rejecter of this.rejecters.splice(0)) rejecter(error);
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: () => {
        this.done = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return Promise.resolve({ value: this.values.shift() as T, done: false });
    }
    if (this.error) return Promise.reject(this.error);
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push(resolve);
      this.rejecters.push(reject);
    });
  }
}

export class OpenCodeAdapter implements ProviderAdapter {
  private readonly workers: OpenCodeWorker[] = [];
  private readonly sessionWorkers = new Map<string, OpenCodeWorker>();
  private readonly activeByWorker = new Map<OpenCodeWorker, number>();
  private readonly idleTimers = new Map<OpenCodeWorker, NodeJS.Timeout>();
  private totalActive = 0;
  private readonly activeSessions = new Map<string, string>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private closed = false;

  constructor(
    private readonly config: OpenCodeProviderConfig,
    private readonly store: Store,
  ) {}

  private createWorker(): OpenCodeWorker {
    const worker = new OpenCodeWorker(this.config);
    this.workers.push(worker);
    this.activeByWorker.set(worker, 0);
    return worker;
  }

  private getAnyWorker(): OpenCodeWorker {
    const ready = this.workers.find((worker) => worker.isReady());
    if (ready) return ready;
    const starting = this.workers.find((worker) => worker.snapshot().state !== 'stopped');
    if (starting) return starting;
    return this.createWorker();
  }

  workerSnapshot(): WorkerSnapshot {
    const snapshots = this.workers.map((worker) => worker.snapshot());
    const ready = snapshots.find((snapshot) => snapshot.state === 'ready');
    if (ready) return ready;
    const starting = snapshots.find(
      (snapshot) => snapshot.state === 'starting' || snapshot.state === 'restarting',
    );
    if (starting) return starting;
    return (
      snapshots[0] ?? {
        state: 'idle',
        mode: this.config.baseUrl ? 'external' : 'spawn',
        baseUrl: this.config.baseUrl ?? null,
        pid: null,
        port: null,
        restarts: 0,
        lastError: null,
        startedAt: null,
        workspace: null,
        rssMb: null,
      }
    );
  }

  poolSnapshot(): {
    workers: WorkerSnapshot[];
    activeSessions: number;
    maxSessions: number;
    totalRssMb: number;
    memoryBudgetMb: number;
  } {
    const workers = this.workers.map((worker) => worker.snapshot());
    return {
      workers,
      activeSessions: this.totalActive,
      maxSessions: this.config.maxWorkers * this.config.maxConcurrentSessions,
      totalRssMb: workers.reduce((sum, worker) => sum + (worker.rssMb ?? 0), 0),
      memoryBudgetMb: this.config.memoryBudgetMb,
    };
  }

  private async enforceMemoryBudget(): Promise<void> {
    const budget = this.config.memoryBudgetMb;
    if (!budget) return;
    const total = this.workers.reduce(
      (sum, worker) => sum + (worker.snapshot().rssMb ?? 0),
      0,
    );
    if (total < budget) return;
    const idle = this.workers
      .filter(
        (worker) =>
          (this.activeByWorker.get(worker) ?? 0) === 0 &&
          worker.snapshot().mode === 'spawn',
      )
      .sort((a, b) => (b.snapshot().rssMb ?? 0) - (a.snapshot().rssMb ?? 0))[0];
    if (idle) {
      await this.stopWorker(idle);
      return this.enforceMemoryBudget();
    }
    throw new UpstreamError(
      `opencode 内存预算已满（${Math.round(total)}MB / ${budget}MB）`,
      {
        category: 'rate_limit',
        status: 429,
        retryable: false,
        retryAfterMs: 30000,
      },
    );
  }

  private async pickWorker(
    gatewaySessionId: string,
    oneShot: boolean,
  ): Promise<OpenCodeWorker> {
    const existing = this.sessionWorkers.get(gatewaySessionId);
    if (
      existing &&
      this.workers.includes(existing) &&
      (this.activeByWorker.get(existing) ?? 0) < this.config.maxConcurrentSessions
    ) {
      return existing;
    }
    await this.enforceMemoryBudget();
    const capacity = this.config.maxWorkers * this.config.maxConcurrentSessions;
    if (this.totalActive >= capacity) {
      throw new UpstreamError('opencode 渠道并发已满', {
        category: 'rate_limit',
        status: 429,
        retryable: false,
        retryAfterMs: 5000,
      });
    }
    let candidates = this.workers.filter(
      (worker) =>
        (this.activeByWorker.get(worker) ?? 0) < this.config.maxConcurrentSessions,
    );
    if (
      candidates.length === 0 &&
      !this.config.baseUrl &&
      this.workers.length < this.config.maxWorkers
    ) {
      candidates = [this.createWorker()];
    }
    if (candidates.length === 0 && this.workers.length === 0) {
      candidates = [this.createWorker()];
    }
    if (candidates.length === 0) {
      throw new UpstreamError('opencode 渠道并发已满', {
        category: 'rate_limit',
        status: 429,
        retryable: false,
        retryAfterMs: 5000,
      });
    }
    const worker = candidates.sort(
      (a, b) => (this.activeByWorker.get(a) ?? 0) - (this.activeByWorker.get(b) ?? 0),
    )[0];
    if (!oneShot) this.sessionWorkers.set(gatewaySessionId, worker);
    const idleTimer = this.idleTimers.get(worker);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(worker);
    }
    return worker;
  }

  private acquireSlot(worker: OpenCodeWorker): void {
    this.totalActive += 1;
    this.activeByWorker.set(worker, (this.activeByWorker.get(worker) ?? 0) + 1);
  }

  private releaseSlot(
    worker: OpenCodeWorker,
    gatewaySessionId: string,
    oneShot: boolean,
  ): void {
    this.totalActive = Math.max(0, this.totalActive - 1);
    const next = Math.max(0, (this.activeByWorker.get(worker) ?? 0) - 1);
    this.activeByWorker.set(worker, next);
    if (oneShot) this.sessionWorkers.delete(gatewaySessionId);
    if (next === 0) this.scheduleIdleStop(worker);
    void this.enforceMemoryBudget().catch(() => {});
  }

  private scheduleIdleStop(worker: OpenCodeWorker): void {
    if (this.config.baseUrl || this.closed) return;
    const existing = this.idleTimers.get(worker);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.idleTimers.delete(worker);
      if ((this.activeByWorker.get(worker) ?? 0) === 0) {
        void this.stopWorker(worker);
      }
    }, this.config.idleTtlMs);
    timer.unref?.();
    this.idleTimers.set(worker, timer);
  }

  private async stopWorker(worker: OpenCodeWorker): Promise<void> {
    if ((this.activeByWorker.get(worker) ?? 0) > 0) return;
    const index = this.workers.indexOf(worker);
    if (index < 0) return;
    this.workers.splice(index, 1);
    this.activeByWorker.delete(worker);
    const timer = this.idleTimers.get(worker);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(worker);
    }
    for (const [sessionId, mapped] of this.sessionWorkers) {
      if (mapped === worker) this.sessionWorkers.delete(sessionId);
    }
    await worker.stop();
  }

  async listModelInfos(): Promise<ModelConfig[]> {
    const worker = this.getAnyWorker();
    await worker.ensureStarted();
    // codearts（IDE 内核）没有 /api/model 目录，等价物是 /provider 的 all[].models 映射。
    let entries: Array<Record<string, any>>;
    if (this.config.flavor === 'codearts') {
      const response = await worker.api<{ all?: Array<Record<string, any>> }>(
        'GET',
        '/api/provider',
      );
      entries = [];
      for (const provider of response.all ?? []) {
        const models = provider?.models;
        if (!models || typeof models !== 'object') continue;
        for (const entry of Object.values(models)) {
          if (entry && typeof entry === 'object') entries.push(entry as Record<string, any>);
        }
      }
    } else {
      const response = await worker.api<{ data?: Array<Record<string, any>> }>(
        'GET',
        '/api/model',
      );
      entries = response.data ?? [];
    }
    const models: ModelConfig[] = [];
    const usedIds = new Set<string>();
    for (const raw of entries) {
      // 原版 opencode：缺 type 的条目是配置残影，必须过滤（实际请求返回 Model is unavailable）。
      // kilo fork（v7.8.27 实测）：所有条目都没有 type 字段且真实可用，只按 enabled/status 过滤。
      // codearts（v126.11.1 实测）：/provider 条目同样无 type，按 status 过滤。
      if (this.config.flavor === 'kilo' || this.config.flavor === 'codearts') {
        if (raw == null || typeof raw !== 'object') continue;
      } else if (raw?.type !== 'chat') {
        continue;
      }
      if (raw.enabled === false || raw.status === 'disabled') continue;
      const providerID = String(raw.providerID ?? '');
      const modelID = String(raw.modelID ?? raw.id ?? '');
      if (!providerID || !modelID) continue;
      // 渠道级发现白名单（glob）：如 kilo 只接入 *:free；手工 models 不受影响。
      // 模式同时匹配 modelID 与 providerID/modelID，后者用于按上游 provider
      // 精准放行（如订阅渠道 opencode-go/*），不影响 *free* 这类旧写法。
      const qualified = `${providerID}/${modelID}`;
      if (
        this.config.modelFilter.length > 0 &&
        !this.config.modelFilter.some(
          (pattern) =>
            matchesGlob(modelID, pattern) || matchesGlob(qualified, pattern),
        )
      ) {
        continue;
      }
      const capabilities = raw.capabilities ?? {};
      // codearts 的 capabilities.input 是 {text:true,image:true,...} 布尔映射；
      // 原版/kilo 是字符串数组。tools 在 codearts 里叫 toolcall。
      const input = Array.isArray(capabilities.input)
        ? capabilities.input
        : capabilities.input && typeof capabilities.input === 'object'
          ? Object.entries(capabilities.input)
              .filter(([, enabled]) => enabled === true)
              .map(([name]) => name)
          : [];
      const variants = Array.isArray(raw.variants) ? raw.variants : [];
      const reasoningVariants: Record<string, string> = {};
      for (const variant of variants) {
        const effort = variant?.settings?.reasoningEffort;
        if (typeof effort === 'string' && typeof variant?.id === 'string') {
          reasoningVariants[effort] = variant.id;
        }
      }
      const reasoning =
        // kilo fork 的模型目录不带 variants，但 UI 对所有模型开放 effort 选择
        // （会话级 variant 承载档位），标记 reasoning 让带 reasoning_effort
        // 的请求不被能力过滤拦下；不支持的模型由 kilo 侧优雅降级。
        this.config.flavor === 'kilo' ||
        Boolean(raw.compatibility?.reasoningField) ||
        variants.some(
          (variant: any) =>
            variant?.settings &&
            (variant.settings.reasoningEffort !== undefined ||
              variant.settings.reasoning !== undefined),
        ) ||
        /reason|thinking|\br1\b|\bqwq\b|\bo[134]\b|deepseek-r|gpt-5/i.test(modelID);
      // codearts 的 cost 是单对象 {input,output,cache}；原版/kilo 是数组。
      const cost = Array.isArray(raw.cost) ? raw.cost[0] : raw.cost;
      const pricing =
        cost && typeof cost === 'object'
          ? {
              inputPerMtok: typeof cost.input === 'number' ? cost.input : undefined,
              outputPerMtok: typeof cost.output === 'number' ? cost.output : undefined,
              cacheReadPerMtok:
                typeof cost.cache?.read === 'number' ? cost.cache.read : undefined,
              cacheWritePerMtok:
                typeof cost.cache?.write === 'number' ? cost.cache.write : undefined,
            }
          : undefined;
      let id = modelID;
      if (usedIds.has(id)) id = `${providerID}/${modelID}`;
      usedIds.add(id);
      models.push({
        id,
        upstream: `${providerID}/${modelID}`,
        reasoningVariants:
          Object.keys(reasoningVariants).length > 0 ? reasoningVariants : undefined,
        contextWindow:
          typeof raw.limit?.context === 'number' ? raw.limit.context : undefined,
        maxOutputTokens:
          typeof raw.limit?.output === 'number' ? raw.limit.output : undefined,
        capabilities: {
          tools:
            capabilities.tools !== false &&
            (capabilities.toolcall === undefined || capabilities.toolcall !== false),
          vision: input.includes('image'),
          reasoning,
        },
        pricing,
        source: 'upstream',
      });
    }
    return models;
  }

  listPendingQuestions(): PendingQuestionView[] {
    return [...this.pendingQuestions.values()].map((pending) => ({
      id: pending.id,
      providerId: this.config.id,
      gatewaySessionId: pending.runtime.gatewaySessionId,
      ocSessionId: pending.runtime.ocSessionId,
      kind: pending.kind,
      payload: pending.payload,
      createdAt: pending.createdAt,
    }));
  }

  async answerQuestion(id: string, raw: unknown): Promise<void> {
    const pending = this.pendingQuestions.get(id);
    if (!pending) {
      throw new GatewayError('提问不存在或已处理', { status: 404, type: 'not_found_error' });
    }
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    try {
      if (pending.kind === 'form') {
        const answer = record.answer;
        if (!answer || typeof answer !== 'object') {
          throw new GatewayError('表单回答必须是对象', {
            status: 400,
            type: 'invalid_request_error',
          });
        }
        if (this.config.flavor === 'kilo') {
          // kilo fork 没有 form 路由，等价物是 question（SDK 实测 body 为 answers 数组）。
          await pending.runtime.worker.api(
            'POST',
            `/api/session/${pending.runtime.ocSessionId}/question/${pending.requestId}/reply`,
            { answers: [answer] },
          );
        } else {
          await pending.runtime.worker.api(
            'POST',
            `/api/session/${pending.runtime.ocSessionId}/form/${pending.requestId}/reply`,
            { answer },
          );
        }
      } else {
        const decision = record.decision;
        if (decision !== 'once' && decision !== 'always' && decision !== 'reject') {
          throw new GatewayError('审批决定必须是 once / always / reject', {
            status: 400,
            type: 'invalid_request_error',
          });
        }
        // kilo fork：permission reply 的 body 键是 { reply }（SDK 实测枚举
        // once/always/reject 与原版一致）；原版 opencode 是 { decision }。
        // codearts 沿用原版 { decision }（旧版 opencode API，未实测差异时保守一致）。
        await pending.runtime.worker.api(
          'POST',
          `/api/session/${pending.runtime.ocSessionId}/permission/${pending.requestId}/reply`,
          this.config.flavor === 'kilo' ? { reply: decision } : { decision },
        );
      }
    } catch (error) {
      // kilo 侧已丢弃该请求（任务已结束/worker 回收/服务重启）时是 404：
      // 清掉陈旧挂起项并给客户端可理解的提示，而不是裸 502。
      if (error instanceof UpstreamError && error.status === 404) {
        this.clearPending(pending, 'expired');
        throw new GatewayError(
          `该${pending.kind === 'form' ? '提问' : '审批'}请求已失效（对应任务已结束或服务端已丢弃），请重新发起对话`,
          { status: 410, type: 'invalid_request_error', code: 'request_expired' },
        );
      }
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(`提交回答失败: ${(error as Error).message}`, {
        status: 502,
        type: 'upstream_error',
      });
    }
    this.clearPending(pending, 'answered', raw);
    pending.runtime.suspended = false;
    this.store.updateOcTask(pending.runtime.taskId, 'running');
  }

  private clearPending(
    pending: PendingQuestion,
    status: 'answered' | 'expired',
    answer?: unknown,
  ): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingQuestions.delete(pending.id);
    pending.runtime.pendingQuestionIds.delete(pending.id);
    this.stopKeepalive(pending.runtime);
    this.store.resolveOcQuestion(pending.id, status, answer);
  }

  private stopKeepalive(runtime: TaskRuntime): void {
    if (runtime.keepaliveTimer) {
      clearInterval(runtime.keepaliveTimer);
      runtime.keepaliveTimer = null;
    }
  }

  /**
   * 首包看门狗：
   * - 心跳：上游静默超过 streamHeartbeatMs 就向客户端发 SSE 注释帧，避免客户端空闲超时先掐断；
   * - 预算：firstByteTimeoutMs 内没有任何上游事件，就中断任务并抛明确错误，不再「静默黑洞」。
   */
  private startWatchdogs(
    runtime: TaskRuntime,
    emit: (event: StreamEvent) => void,
    resolveOutcome: (outcome: TaskOutcome) => void,
  ): void {
    const heartbeatMs = this.config.streamHeartbeatMs;
    if (heartbeatMs > 0) {
      runtime.heartbeatTimer = setInterval(() => {
        if (runtime.suspended) return; // 等待用户输入时有独立的提问心跳
        if (Date.now() - runtime.lastEventAt < heartbeatMs) return;
        emit({ type: 'keepalive' });
      }, heartbeatMs);
      runtime.heartbeatTimer.unref?.();
    }
    const firstByteMs = this.config.firstByteTimeoutMs;
    if (firstByteMs > 0) {
      runtime.firstByteTimer = setTimeout(() => {
        runtime.firstByteTimer = null;
        if (runtime.sawProgress) return;
        runtime.lastError = `opencode 首包等待超时：${Math.round(firstByteMs / 1000)}s 内未收到任何上游事件`;
        log.warn(
          `opencode[${this.config.id}] 首包超时 task=${runtime.taskId} session=${runtime.ocSessionId}（${firstByteMs}ms）`,
        );
        void this.interrupt(runtime.worker, runtime.ocSessionId);
        resolveOutcome('first_byte_timeout');
      }, firstByteMs);
      runtime.firstByteTimer.unref?.();
    }
  }

  private stopWatchdogs(runtime: TaskRuntime): void {
    if (runtime.heartbeatTimer) {
      clearInterval(runtime.heartbeatTimer);
      runtime.heartbeatTimer = null;
    }
    if (runtime.firstByteTimer) {
      clearTimeout(runtime.firstByteTimer);
      runtime.firstByteTimer = null;
    }
  }

  private cleanupPendingForRuntime(runtime: TaskRuntime): void {
    for (const id of [...runtime.pendingQuestionIds]) {
      const pending = this.pendingQuestions.get(id);
      if (pending) {
        this.clearPending(pending, 'expired');
      }
    }
    this.stopKeepalive(runtime);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of [...this.pendingQuestions.values()]) {
      this.clearPending(pending, 'expired');
    }
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.sessionWorkers.clear();
    const workers = [...this.workers];
    this.workers.length = 0;
    await Promise.all(workers.map((worker) => worker.stop()));
  }

  async chat(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
  ): Promise<CanonicalResponse> {
    return this.executeTask(request, model, ctx, () => {});
  }

  async *chatStream(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
  ): AsyncGenerator<StreamEvent, void, void> {
    const queue = new EventQueue<StreamEvent>();
    const run = this.executeTask(request, model, ctx, (event) => queue.push(event));
    run.then(
      () => queue.end(),
      (error) => queue.fail(error),
    );
    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      void run.catch(() => {});
    }
  }

  private async ensureSession(
    worker: OpenCodeWorker,
    gatewaySessionId: string,
    model: ModelConfig,
    ref: ModelRef,
    oneShot: boolean,
    workspace?: string,
  ): Promise<{ ocSessionId: string }> {
    let row = this.store.getOcSession(gatewaySessionId, this.config.id);
    let currentDirectory: string | undefined;
    if (row) {
      try {
        if (this.config.flavor === 'codearts') {
          // codearts 旧版 API：GET /session/:id 直接返回会话对象，directory 是顶层字段。
          const info = await worker.api<{ directory?: string }>(
            'GET',
            `/api/session/${row.ocSessionId}`,
          );
          const directory = info?.directory;
          if (directory) currentDirectory = resolve(directory);
        } else {
          const info = await worker.api<{
            data?: { location?: { directory?: string } };
          }>('GET', `/api/session/${row.ocSessionId}`);
          const directory = info?.data?.location?.directory;
          if (directory) currentDirectory = resolve(directory);
        }
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) {
          this.store.deleteOcSession(gatewaySessionId, this.config.id);
          this.store.resetLedgerDelivered(gatewaySessionId);
          log.warn(`opencode 会话 ${row.ocSessionId} 不存在，重建并重放账本`);
          row = null;
        } else {
          throw error;
        }
      }
    }
    if (row) {
      if (workspace) {
        const same =
          currentDirectory !== undefined &&
          normalizePathForCompare(currentDirectory) === normalizePathForCompare(workspace);
        if (!same) {
          throw new UpstreamError(
            `该会话已绑定工作区 ${currentDirectory ?? '(未知)'}，不能切换到 ${workspace}；请使用新的 x-code2api-session`,
            { category: 'bad_request', status: 400, retryable: false },
          );
        }
      }
      const hasVariants = Object.keys(model.reasoningVariants ?? {}).length > 0;
      if (row.modelUpstream !== model.upstream || ref.variant !== undefined || hasVariants) {
        // codearts 旧版 API 没有会话级 /model 路由；模型在每次 /message 提交时携带，
        // 这里只更新本地账本记录。
        if (this.config.flavor !== 'codearts') {
          await worker.api('POST', `/api/session/${row.ocSessionId}/model`, {
            model: ref,
          });
        }
        if (row.modelUpstream !== model.upstream) {
          this.store.upsertOcSession({
            ...row,
            modelPublic: model.id,
            modelUpstream: model.upstream,
            updatedAt: Date.now(),
          });
        }
      }
      return { ocSessionId: row.ocSessionId };
    }

    // codearts 旧版 API：POST /session?directory=... 直接返回会话对象（无 data 包裹），
    // 工作区用查询参数而不是 location 字段。
    const created =
      this.config.flavor === 'codearts'
        ? await worker.api<{ id?: string }>(
            'POST',
            `/api/session${workspace ? `?directory=${encodeURIComponent(workspace)}` : ''}`,
            {
              title: `code2api ${gatewaySessionId}`,
              model: { providerID: ref.providerID, modelID: ref.id },
              ...(this.config.agent ? { agent: this.config.agent } : {}),
            },
          )
        : await worker.api<{
            data?: { id?: string };
          }>('POST', '/api/session', {
            title: `code2api ${gatewaySessionId}`,
            model: ref,
            ...(this.config.agent ? { agent: this.config.agent } : {}),
            ...(workspace ? { location: { directory: workspace } } : {}),
          });
    const ocSessionId =
      this.config.flavor === 'codearts'
        ? (created as { id?: string })?.id
        : (created as { data?: { id?: string } })?.data?.id;
    if (!ocSessionId) {
      throw new UpstreamError('opencode 创建会话失败：响应缺少 session id', {
        category: 'server',
        retryable: true,
      });
    }
    if (workspace) {
      log.info(`opencode 会话 ${ocSessionId} 工作区: ${workspace}`);
    }
    this.store.upsertOcSession({
      gatewaySessionId,
      providerId: this.config.id,
      ocSessionId,
      modelPublic: model.id,
      modelUpstream: model.upstream,
      oneShot,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { ocSessionId };
  }

  private buildPrompt(gatewaySessionId: string, request: CanonicalRequest): string {
    const occurrences = new Map<string, number>();
    const items: Array<{ msgId: string; role: string; text: string }> = [];
    for (const message of request.messages) {
      if (message.role !== 'user' && message.role !== 'system') continue;
      const text = textOf(message.parts).trim();
      if (!text) continue;
      const base = `${message.role}\u0000${text}`;
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      const msgId = createHash('sha256')
        .update(`${base}\u0000${occurrence}`)
        .digest('hex');
      items.push({ msgId, role: message.role, text });
    }
    this.store.insertLedgerMessages(gatewaySessionId, items);

    let undelivered = this.store.getUndeliveredLedger(gatewaySessionId);
    if (undelivered.length === 0) {
      const lastUser = this.store.getLastUserLedger(gatewaySessionId);
      if (!lastUser) {
        throw new UpstreamError('任务需要至少一条用户文本消息', {
          category: 'bad_request',
          retryable: false,
        });
      }
      undelivered = [lastUser];
    }
    return undelivered
      .map((item) => (item.role === 'system' ? `[系统说明]\n${item.text}` : item.text))
      .join('\n\n');
  }

  private emitNote(runtime: TaskRuntime, emit: (event: StreamEvent) => void, text: string): void {
    const note = `\n\n[Code2Api] ${text}\n\n`;
    runtime.text += note;
    emit({ type: 'text_delta', text: note });
  }

  private addQuestion(
    runtime: TaskRuntime,
    kind: 'form' | 'permission',
    requestId: string,
    payload: unknown,
    resolveOutcome: (outcome: TaskOutcome) => void,
    emit: (event: StreamEvent) => void,
    note: string,
  ): void {
    const existing = [...this.pendingQuestions.values()].find(
      (item) => item.requestId === requestId && item.runtime.taskId === runtime.taskId,
    );
    if (existing) return;
    const id = `ocq_${randomUUID()}`;
    const pending: PendingQuestion = {
      id,
      kind,
      requestId,
      runtime,
      payload,
      createdAt: Date.now(),
      timer: null,
      resolveOutcome,
    };
    pending.timer = setTimeout(() => {
      const current = this.pendingQuestions.get(id);
      if (!current) return;
      this.clearPending(current, 'expired');
      runtime.lastError = '等待用户回答超时';
      void this.interrupt(runtime.worker, runtime.ocSessionId);
      resolveOutcome('failed');
    }, this.config.questionTimeoutMs);
    this.pendingQuestions.set(id, pending);
    runtime.pendingQuestionIds.add(id);
    runtime.suspended = true;
    // 挂起等待用户输入期间周期性发 SSE 心跳（注释帧，客户端语义上忽略但字节不断），
    // 否则客户端的空闲超时（如 dsh 的 300s）会把连接和任务一起掐掉，
    // 用户就永远等不到“几小时后从容回答”。
    if (!runtime.keepaliveTimer) {
      const intervalMs = Math.max(
        3000,
        Math.min(15000, Math.floor(this.config.questionTimeoutMs / 8)),
      );
      runtime.keepaliveTimer = setInterval(() => emit({ type: 'keepalive' }), intervalMs);
    }
    this.store.createOcQuestion({
      id,
      gatewaySessionId: runtime.gatewaySessionId,
      providerId: this.config.id,
      ocSessionId: runtime.ocSessionId,
      kind,
      requestId,
      payload,
    });
    this.store.updateOcTask(runtime.taskId, 'suspended');
    this.emitNote(runtime, emit, note);
  }

  private async replyPermission(
    runtime: TaskRuntime,
    requestId: string,
    decision: 'once' | 'always' | 'reject',
  ): Promise<void> {
    await runtime.worker.api(
      'POST',
      `/api/session/${runtime.ocSessionId}/permission/${requestId}/reply`,
      this.config.flavor === 'kilo' ? { reply: decision } : { decision },
    );
  }

  /**
   * 首包预算只认「模型真的开始处理」的事件：
   * - 用户消息回显（message.updated role=user）会立刻到达，不能拿来抵消首包预算；
   * - 文本/推理/step/工具/执行结果/提问/权限请求都算上游有响应；
   * - permission.replied / session.form.replied 是面板侧动作，不算。
   */
  private countsAsProgress(event: OpenCodeEvent, runtime: TaskRuntime): boolean {
    const data = event.data ?? {};
    switch (event.type) {
      case 'message.updated': {
        const info = (data.info ?? {}) as Record<string, unknown>;
        return info.role === 'assistant';
      }
      case 'message.part.updated': {
        const part = (data.part ?? {}) as Record<string, unknown>;
        const messageID = typeof part.messageID === 'string' ? part.messageID : '';
        return runtime.messageRoles.get(messageID) !== 'user';
      }
      case 'permission.replied':
      case 'session.form.replied':
        return false;
      case 'form.created':
      case 'permission.asked':
        return true;
      default:
        return (
          event.type.startsWith('session.') ||
          event.type.startsWith('message.') ||
          event.type.startsWith('permission.')
        );
    }
  }

  private handleEvent(
    runtime: TaskRuntime,
    event: OpenCodeEvent,
    emit: (event: StreamEvent) => void,
    resolveOutcome: (outcome: TaskOutcome) => void,
  ): void {
    runtime.eventsSeen += 1;
    runtime.lastEventAt = Date.now();
    if (runtime.firstByteTimer && this.countsAsProgress(event, runtime)) {
      runtime.sawProgress = true;
      clearTimeout(runtime.firstByteTimer);
      runtime.firstByteTimer = null;
      log.debug(`opencode[${this.config.id}] 首包到达: ${event.type}`);
    }
    const data = event.data ?? {};
    switch (event.type) {
      case 'session.text.delta': {
        const delta = typeof data.delta === 'string' ? data.delta : '';
        if (delta) {
          runtime.text += delta;
          emit({ type: 'text_delta', text: delta });
        }
        break;
      }
      case 'session.text.ended': {
        const text = typeof data.text === 'string' ? data.text : '';
        if (text && !runtime.text) {
          runtime.text = text;
          emit({ type: 'text_delta', text });
        }
        break;
      }
      case 'session.reasoning.delta': {
        const delta =
          typeof data.delta === 'string'
            ? data.delta
            : typeof data.text === 'string'
              ? data.text
              : '';
        if (delta) {
          runtime.thinking += delta;
          emit({ type: 'thinking_delta', text: delta });
        }
        break;
      }
      case 'session.step.ended': {
        runtime.steps += 1;
        const tokens = (data.tokens ?? {}) as Record<string, any>;
        const cache = (tokens.cache ?? {}) as Record<string, unknown>;
        // 累加 = 上游真实消耗（记账）；末步快照 = 当前内部对话规模（客户端可见）。
        runtime.lastStepUsage = {
          inputTokens: Number(tokens.input ?? 0),
          outputTokens: Number(tokens.output ?? 0),
          reasoningTokens: Number(tokens.reasoning ?? 0),
          cacheReadTokens: Number(cache.read ?? 0),
          cacheWriteTokens: Number(cache.write ?? 0),
          estimated: false,
        };
        runtime.usage.inputTokens += Number(tokens.input ?? 0);
        runtime.usage.outputTokens += Number(tokens.output ?? 0);
        runtime.usage.reasoningTokens =
          (runtime.usage.reasoningTokens ?? 0) + Number(tokens.reasoning ?? 0);
        runtime.usage.cacheReadTokens =
          (runtime.usage.cacheReadTokens ?? 0) + Number(cache.read ?? 0);
        runtime.usage.cacheWriteTokens =
          (runtime.usage.cacheWriteTokens ?? 0) + Number(cache.write ?? 0);
        if (data.finish) runtime.finish = mapFinish(data.finish);
        break;
      }
      case 'session.step.failed':
        runtime.lastError = eventError(event);
        break;
      case 'session.execution.succeeded':
        resolveOutcome('succeeded');
        break;
      case 'session.execution.failed':
        runtime.lastError = eventError(event);
        resolveOutcome('failed');
        break;
      case 'session.execution.interrupted':
        resolveOutcome('interrupted');
        break;
      case 'session.error':
        runtime.lastError = eventError(event);
        resolveOutcome('failed');
        break;
      case 'session.idle':
        resolveOutcome(data.outcome === 'failed' ? 'failed' : 'succeeded');
        break;
      case 'message.part.updated': {
        // kilo/codearts fork：文本/推理以 part 累积全文反复推送（原版是 session.text.delta 增量）；
        // synthetic part 是转圈占位符，忽略；user 消息的 part 更新绝不能当模型输出透传。
        if (this.config.flavor !== 'kilo' && this.config.flavor !== 'codearts') break;
        const part = (data.part ?? {}) as Record<string, any>;
        const partId = typeof part.id === 'string' ? part.id : '';
        if (!partId || part.synthetic) break;
        const role = runtime.messageRoles.get(String(part.messageID ?? ''));
        if (role !== undefined && role !== 'assistant') break;
        if (role === undefined) break;
        const full = typeof part.text === 'string' ? part.text : '';
        const prev = runtime.partTexts.get(partId) ?? 0;
        if (full.length <= prev) break;
        const delta = full.slice(prev);
        runtime.partTexts.set(partId, full.length);
        if (part.type === 'reasoning' || part.type === 'thinking') {
          runtime.thinking += delta;
          emit({ type: 'thinking_delta', text: delta });
        } else if (part.type === 'text') {
          runtime.text += delta;
          emit({ type: 'text_delta', text: delta });
        }
        break;
      }
      case 'message.updated': {
        // kilo/codearts fork：登记消息角色（part 过滤依据），并回填 assistant 消息级用量。
        if (this.config.flavor !== 'kilo' && this.config.flavor !== 'codearts') break;
        const info = (data.info ?? {}) as Record<string, any>;
        if (typeof info.id !== 'string' || !info.id) break;
        if (typeof info.role === 'string') {
          runtime.messageRoles.set(info.id, info.role);
        }
        if (info.role !== 'assistant') break;
        const tokens = (info.tokens ?? {}) as Record<string, any>;
        if (!tokens || typeof tokens !== 'object') break;
        const cache = (tokens.cache ?? {}) as Record<string, unknown>;
        runtime.usage.inputTokens = Number(tokens.input ?? 0);
        runtime.usage.outputTokens = Number(tokens.output ?? 0);
        runtime.usage.reasoningTokens = Number(tokens.reasoning ?? 0);
        runtime.usage.cacheReadTokens = Number(cache.read ?? 0);
        runtime.usage.cacheWriteTokens = Number(cache.write ?? 0);
        runtime.usage.estimated = false;
        runtime.lastStepUsage = {
          inputTokens: Number(tokens.input ?? 0),
          outputTokens: Number(tokens.output ?? 0),
          reasoningTokens: Number(tokens.reasoning ?? 0),
          cacheReadTokens: Number(cache.read ?? 0),
          cacheWriteTokens: Number(cache.write ?? 0),
          estimated: false,
        };
        break;
      }
      case 'session.form.replied': {
        const requestId = typeof data.id === 'string' ? data.id : '';
        const pending = [...this.pendingQuestions.values()].find(
          (item) => item.requestId === requestId,
        );
        if (pending) {
          this.clearPending(pending, 'answered', { answer: data.answer });
          pending.runtime.suspended = false;
        }
        break;
      }
      case 'permission.replied': {
        const requestId =
          typeof data.requestID === 'string' ? data.requestID : '';
        const pending = [...this.pendingQuestions.values()].find(
          (item) => item.requestId === requestId,
        );
        if (pending) {
          this.clearPending(pending, 'answered', { decision: data.reply });
          pending.runtime.suspended = false;
        }
        break;
      }
      case 'form.created': {
        const form = data.form as Record<string, any> | undefined;
        if (!form || typeof form.id !== 'string') break;
        const title = typeof form.title === 'string' ? form.title : '需要确认';
        this.addQuestion(
          runtime,
          'form',
          form.id,
          form,
          resolveOutcome,
          emit,
          `需要你的确认：${title}。请到 Code2Api 面板「待处理提问」中回答。`,
        );
        break;
      }
      case 'permission.asked': {
        const requestId = typeof data.id === 'string' ? data.id : '';
        if (!requestId) break;
        const action = typeof data.action === 'string' ? data.action : 'unknown';
        const resources = Array.isArray(data.resources) ? data.resources.join(', ') : '';
        if (this.config.permissionMode !== 'ask') {
          const decision = this.config.permissionMode === 'allow' ? 'once' : 'reject';
          void this.replyPermission(runtime, requestId, decision).catch((error) => {
            log.warn(`opencode 自动审批失败: ${(error as Error).message}`);
            this.addQuestion(
              runtime,
              'permission',
              requestId,
              data,
              resolveOutcome,
              emit,
              `需要审批：${action} ${resources}。自动审批失败，请到面板处理。`,
            );
          });
        } else {
          this.addQuestion(
            runtime,
            'permission',
            requestId,
            data,
            resolveOutcome,
            emit,
            `需要审批：${action} ${resources}。请到 Code2Api 面板「待处理提问」中允许或拒绝。`,
          );
        }
        break;
      }
      case 'session.tool.called':
      case 'session.tool.success':
      case 'session.tool.failed':
      case 'session.tool.progress': {
        const line = toolEventText(event);
        if (line) {
          runtime.thinking += line;
          emit({ type: 'thinking_delta', text: line });
        }
        log.debug(
          `opencode[${this.config.id}] 工具事件 ${event.type} ${String(data.name ?? data.id ?? '')}`,
        );
        break;
      }
      case 'session.retry.scheduled':
        log.warn(`opencode 任务重试调度: ${eventError(event)}`);
        break;
      default:
        break;
    }
  }

  private async interrupt(worker: OpenCodeWorker, sessionId: string): Promise<void> {
    try {
      await worker.api('POST', `/api/session/${sessionId}/interrupt`);
    } catch (error) {
      log.warn(`opencode 中断失败: ${(error as Error).message}`);
    }
  }

  private async fetchFinalText(runtime: TaskRuntime): Promise<string> {
    if (runtime.text) return runtime.text;
    try {
      if (this.config.flavor === 'codearts') {
        // codearts 旧版 API：GET /session/:id/message 直接返回数组，
        // 每项 {info:{role,time,...}, parts:[{type,text}]}。
        const messages = await runtime.worker.api<Array<Record<string, any>>>(
          'GET',
          `/api/session/${runtime.ocSessionId}/message`,
        );
        for (const message of Array.isArray(messages) ? messages : []) {
          const info = message.info ?? {};
          if (info.role !== 'assistant') continue;
          if (Number(info.time?.created ?? 0) < runtime.startTime - 1000) continue;
          const parts = Array.isArray(message.parts) ? message.parts : [];
          const text = parts
            .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
            .map((part: any) => part.text)
            .join('');
          if (text) return text;
        }
        return runtime.text;
      }
      const response = await runtime.worker.api<{
        data?: Array<Record<string, any>>;
      }>('GET', `/api/session/${runtime.ocSessionId}/message?limit=30&order=desc`);
      for (const message of response.data ?? []) {
        if (message.type !== 'assistant') continue;
        if (Number(message.time?.created ?? 0) < runtime.startTime - 1000) continue;
        const content = Array.isArray(message.content) ? message.content : [];
        const text = content
          .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join('');
        if (text) return text;
      }
    } catch (error) {
      log.warn(`opencode 读取最终消息失败: ${(error as Error).message}`);
    }
    return runtime.text;
  }

  private async executeTask(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
    emit: (event: StreamEvent) => void,
  ): Promise<CanonicalResponse> {
    if (this.closed) {
      throw new UpstreamError('opencode 渠道已关闭', { category: 'server', retryable: false });
    }
    const ref = parseModelRef(model, request.reasoningEffort, this.config.flavor);
    const workspace = request.workspace?.trim()
      ? resolveWorkspace(request.workspace.trim(), this.config.workspaceRoots)
      : undefined;
    const gatewaySessionId = request.sessionId?.trim() || `oneshot-${randomUUID()}`;
    const oneShot = !request.sessionId;
    if (this.activeSessions.has(gatewaySessionId)) {
      throw new UpstreamError('该会话已有任务在执行，请等待完成', {
        category: 'busy',
        status: 409,
        retryable: false,
      });
    }
    const taskId = `octask_${randomUUID()}`;
    this.activeSessions.set(gatewaySessionId, taskId);

    let runtime: TaskRuntime | null = null;
    let poolWorker: OpenCodeWorker | null = null;
    let slotAcquired = false;
    let unsubscribe = () => {};
    let resolveOutcome!: (outcome: TaskOutcome) => void;
    const completion = new Promise<TaskOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let timeoutTimer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;

    try {
      const worker = await this.pickWorker(gatewaySessionId, oneShot);
      poolWorker = worker;
      this.acquireSlot(worker);
      slotAcquired = true;
      await worker.ensureStarted();
      await worker.waitEventStream(10000);
      const { ocSessionId } = await this.ensureSession(
        worker,
        gatewaySessionId,
        model,
        ref,
        oneShot,
        workspace,
      );
      runtime = {
        taskId,
        worker,
        gatewaySessionId,
        ocSessionId,
        oneShot,
        startTime: Date.now(),
        text: '',
        thinking: '',
        finish: 'stop',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimated: false,
        },
        lastStepUsage: null,
        steps: 0,
        lastError: null,
        suspended: false,
        pendingQuestionIds: new Set(),
        partTexts: new Map(),
        keepaliveTimer: null,
        eventsSeen: 0,
        sawProgress: false,
        lastEventAt: Date.now(),
        heartbeatTimer: null,
        firstByteTimer: null,
        messageRoles: new Map(),
      };
      this.store.recordOcTask({
        id: taskId,
        gatewaySessionId,
        providerId: this.config.id,
        ocSessionId,
        state: 'running',
        createdAt: Date.now(),
      });
      const promptText = this.buildPrompt(gatewaySessionId, request);
      const runtimeRef = runtime;
      unsubscribe = worker.subscribeSession(ocSessionId, (event) =>
        this.handleEvent(runtimeRef, event, emit, resolveOutcome),
      );
      abortListener = () => {
        void this.interrupt(worker, ocSessionId);
        resolveOutcome('interrupted');
      };
      ctx.signal.addEventListener('abort', abortListener, { once: true });
      this.startWatchdogs(runtimeRef, emit, resolveOutcome);

      // 触发执行：kilo fork 的 v1 /prompt 只把输入入队（实测只发 session.next.prompted，
      // agent loop 不调度），必须走 v2 POST /session/:id/message（parts 形式），事件流
      // 与原版兼容（message.part.updated / session.error / session.idle）。
      // codearts（IDE 内核，旧版 opencode API）同样走 /session/:id/message，
      // body 为 {sessionID, model:{providerID,modelID}, parts, agent}（IDE SDK 实测契约），
      // 工作区用 ?directory= 查询参数；/prompt 路由在该版本返回 Cloudflare 500 错误页。
      // 原版 opencode 的 v1 /prompt { text, delivery } 即触发执行。
      if (this.config.flavor === 'kilo') {
        const admitted = await worker.api<{ info?: { id?: string; role?: string } }>(
          'POST',
          `/session/${ocSessionId}/message`,
          { parts: [{ type: 'text', text: promptText }] },
          ctx.signal,
        );
        // 受理响应携带本次输入的 user 消息 id，登记角色以便 part 过滤。
        if (admitted?.info?.id) {
          runtime.messageRoles.set(admitted.info.id, admitted.info.role ?? 'user');
        }
      } else if (this.config.flavor === 'codearts') {
        const dirQuery = workspace ? `?directory=${encodeURIComponent(workspace)}` : '';
        await worker.api(
          'POST',
          `/api/session/${ocSessionId}/message${dirQuery}`,
          {
            sessionID: ocSessionId,
            model: { providerID: ref.providerID, modelID: ref.id },
            parts: [{ type: 'text', text: promptText }],
            ...(this.config.agent ? { agent: this.config.agent } : {}),
            ...(ref.variant ? { variant: ref.variant } : {}),
          },
          ctx.signal,
        );
      } else {
        await worker.api(
          'POST',
          `/api/session/${ocSessionId}/prompt`,
          { text: promptText, delivery: 'steer' },
          ctx.signal,
        );
      }
      this.store.markAllLedgerDelivered(gatewaySessionId);

      const timeout = new Promise<'timeout'>((resolve) => {
        timeoutTimer = setTimeout(() => resolve('timeout'), this.config.taskTimeoutMs);
      });
      const outcome = await Promise.race([completion, timeout]);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (runtime) this.stopWatchdogs(runtime);

      if (outcome === 'first_byte_timeout') {
        this.cleanupPendingForRuntime(runtime);
        await this.interrupt(runtime.worker, ocSessionId);
        throw new UpstreamError(runtime.lastError ?? 'opencode 首包等待超时', {
          category: 'timeout',
          status: 504,
          retryable: false,
        });
      }
      if (outcome === 'timeout') {
        this.cleanupPendingForRuntime(runtime);
        await this.interrupt(runtime.worker, ocSessionId);
        throw new UpstreamError('opencode 任务执行超时', {
          category: 'timeout',
          status: 504,
          retryable: false,
        });
      }
      if (outcome === 'interrupted' || ctx.signal.aborted) {
        this.cleanupPendingForRuntime(runtime);
        throw new UpstreamError('client aborted', {
          category: 'cancelled',
          retryable: false,
        });
      }
      const runtimeDone = runtime;
      if (outcome === 'failed') {
        // 任务失败时 kilo 会丢弃未决的审批/提问，挂起项必须同步清理，
        // 否则用户对着死请求点“继续”会拿到 404。
        this.cleanupPendingForRuntime(runtimeDone);
        throw new UpstreamError(runtimeDone.lastError ?? 'opencode 任务失败', {
          category: 'server',
          retryable: false,
        });
      }

      const finalText = await this.fetchFinalText(runtimeDone);
      if (!runtimeDone.text && finalText) {
        runtimeDone.text = finalText;
        emit({ type: 'text_delta', text: finalText });
      }
      if (runtimeDone.steps === 0) {
        runtimeDone.usage.estimated = true;
      }
      if (!runtimeDone.finish || runtimeDone.finish === 'unknown') {
        runtimeDone.finish = finalText ? 'stop' : 'unknown';
      }
      // 客户端可见 usage = 末步快照（当前对话规模，OpenAI 语义）；
      // 记账/计费用累加值（上游真实消耗），经 upstreamUsage 旁路进数据库。
      const clientUsage = runtimeDone.lastStepUsage ?? runtimeDone.usage;
      emit({ type: 'usage', usage: clientUsage, upstreamUsage: runtimeDone.usage });
      emit({ type: 'finish', reason: runtimeDone.finish });
      this.store.appendAssistantLedger(gatewaySessionId, finalText);
      this.store.updateOcTask(taskId, 'finished', null, runtimeDone.usage);
      this.cleanupPendingForRuntime(runtimeDone);
      return {
        id: `opencode-${taskId}`,
        model: model.id,
        text: finalText,
        thinking: runtimeDone.thinking || undefined,
        toolCalls: [],
        stopReason: runtimeDone.finish,
        usage: clientUsage,
        upstreamUsage: runtimeDone.usage,
      };
    } catch (error) {
      if (runtime) {
        const state = ctx.signal.aborted ? 'interrupted' : 'failed';
        this.store.updateOcTask(
          taskId,
          state,
          (error as Error).message,
          runtime.usage,
        );
        this.cleanupPendingForRuntime(runtime);
      }
      throw error;
    } finally {
      if (abortListener) ctx.signal.removeEventListener('abort', abortListener);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (runtime) this.stopKeepalive(runtime);
      if (runtime) this.stopWatchdogs(runtime);
      unsubscribe();
      this.activeSessions.delete(gatewaySessionId);
      if (runtime?.oneShot) {
        void runtime.worker
          .api('DELETE', `/api/session/${runtime.ocSessionId}`)
          .catch(() => {});
      }
      if (poolWorker && slotAcquired) {
        this.releaseSlot(poolWorker, gatewaySessionId, oneShot);
      }
    }
  }
}
