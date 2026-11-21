import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  textOf,
  type CanonicalRequest,
  type CanonicalResponse,
  type StopReason,
  type StreamEvent,
  type Usage,
} from '../canonical.js';
import type { ModelConfig, ZcodeProviderConfig } from '../config.js';
import { GatewayError, UpstreamError } from '../errors.js';
import { log } from '../logger.js';
import type { Store } from '../store/db.js';
import {
  EventQueue,
  normalizePathForCompare,
  resolveWorkspace,
} from './opencode.js';
import {
  ZcodeWorker,
  type ZcodeProtocolEvent,
  type ZcodeServerRequest,
  type ZcodeWorkerSnapshot,
} from './zcode-worker.js';
import type { ChatContext, ProviderAdapter } from './types.js';

type TaskOutcome = 'succeeded' | 'failed' | 'interrupted';

interface ModelRef {
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
}

interface TaskRuntime {
  taskId: string;
  worker: ZcodeWorker;
  gatewaySessionId: string;
  zcSessionId: string;
  oneShot: boolean;
  startTime: number;
  text: string;
  thinking: string;
  finish: StopReason;
  usage: Usage;
  /** 最后一轮的用量快照 = 客户端可见的「当前对话规模」（usage 字段语义）。 */
  lastTurnUsage: Usage | null;
  lastError: string | null;
  suspended: boolean;
  pendingQuestionIds: Set<string>;
}

interface PendingQuestion {
  id: string;
  kind: 'form' | 'permission';
  requestId: string;
  runtime: TaskRuntime;
  payload: unknown;
  createdAt: number;
  timer: NodeJS.Timeout | null;
  /** 服务端反向请求的应答回调；回答后写回协议帧。 */
  respond: ((result: unknown) => void) | null;
}

export interface PendingQuestionView {
  id: string;
  providerId: string;
  gatewaySessionId: string;
  zcSessionId: string;
  /** 面板兼容字段：与 opencode 的 PendingQuestionView 同名。 */
  ocSessionId: string;
  kind: 'form' | 'permission';
  payload: unknown;
  createdAt: number;
}

function parseModelRef(model: ModelConfig, reasoningEffort?: string): ModelRef {
  const index = model.upstream.indexOf('/');
  if (index <= 0 || index === model.upstream.length - 1) {
    throw new UpstreamError(
      `zcode 模型 ${model.id} 的 upstream 必须是 providerId/modelId，例如 builtin:zai/GLM-5.3-Flash`,
      { category: 'bad_request', retryable: false },
    );
  }
  // CLI 对部分模型强制要求显式推理档位（"Reasoning level is required"），
  // 客户端未指定时回落到模型配置的 reasoning_effort。
  const reasoningLevel = reasoningEffort
    ? model.reasoningVariants?.[reasoningEffort] ?? reasoningEffort
    : model.reasoningEffort;
  return {
    providerId: model.upstream.slice(0, index),
    modelId: model.upstream.slice(index + 1),
    ...(reasoningLevel ? { reasoningLevel } : {}),
  };
}

function eventErrorMessage(payload: Record<string, unknown>): string {
  const error = payload.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const rec = error as Record<string, unknown>;
    if (typeof rec.message === 'string') return rec.message;
    if (typeof rec.type === 'string') return rec.type;
    return JSON.stringify(error).slice(0, 500);
  }
  return 'zcode 任务失败';
}

function mapUsage(
  usage: Usage,
  raw: Record<string, unknown> | undefined,
): void {
  if (!raw) return;
  usage.inputTokens += Number(raw.inputTokens ?? 0);
  usage.outputTokens += Number(raw.outputTokens ?? 0);
  usage.reasoningTokens = (usage.reasoningTokens ?? 0) + Number(raw.reasoningTokens ?? 0);
  usage.cacheReadTokens =
    (usage.cacheReadTokens ?? 0) + Number(raw.cacheReadTokens ?? 0);
  usage.cacheWriteTokens =
    (usage.cacheWriteTokens ?? 0) + Number(raw.cacheWriteTokens ?? 0);
}

const RESULT_TYPE_MESSAGES: Record<string, string> = {
  error_max_turns: '达到最大轮次限制',
  error_max_budget: '达到预算上限',
  error_during_execution: '执行出错',
  error_max_tool_calls: '达到最大工具调用次数',
};

export class ZcodeAdapter implements ProviderAdapter {
  private readonly workers: ZcodeWorker[] = [];
  private readonly sessionWorkers = new Map<string, ZcodeWorker>();
  private readonly activeByWorker = new Map<ZcodeWorker, number>();
  private readonly idleTimers = new Map<ZcodeWorker, NodeJS.Timeout>();
  private totalActive = 0;
  private readonly activeSessions = new Map<string, string>();
  private readonly runtimeByZcSession = new Map<string, TaskRuntime>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private closed = false;

  constructor(
    private readonly config: ZcodeProviderConfig,
    private readonly store: Store,
  ) {}

  private createWorker(): ZcodeWorker {
    const worker = new ZcodeWorker(this.config);
    worker.setInteractionHandler((request) => this.handleInteraction(worker, request));
    this.workers.push(worker);
    this.activeByWorker.set(worker, 0);
    return worker;
  }

  private getAnyWorker(): ZcodeWorker {
    const ready = this.workers.find((worker) => worker.isReady());
    if (ready) return ready;
    const starting = this.workers.find((worker) => worker.snapshot().state !== 'stopped');
    if (starting) return starting;
    return this.createWorker();
  }

  workerSnapshot(): ZcodeWorkerSnapshot {
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
        pid: null,
        restarts: 0,
        lastError: null,
        startedAt: null,
        workspace: resolve(process.cwd(), this.config.workspace),
        logTail: [],
      }
    );
  }

  poolSnapshot(): {
    workers: ZcodeWorkerSnapshot[];
    activeSessions: number;
    maxSessions: number;
  } {
    return {
      workers: this.workers.map((worker) => worker.snapshot()),
      activeSessions: this.totalActive,
      maxSessions: this.config.maxWorkers * this.config.maxConcurrentSessions,
    };
  }

  private async pickWorker(
    gatewaySessionId: string,
    oneShot: boolean,
  ): Promise<ZcodeWorker> {
    const existing = this.sessionWorkers.get(gatewaySessionId);
    if (
      existing &&
      this.workers.includes(existing) &&
      (this.activeByWorker.get(existing) ?? 0) < this.config.maxConcurrentSessions
    ) {
      return existing;
    }
    const capacity = this.config.maxWorkers * this.config.maxConcurrentSessions;
    if (this.totalActive >= capacity) {
      throw new UpstreamError('zcode 渠道并发已满', {
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
    if (candidates.length === 0 && this.workers.length < this.config.maxWorkers) {
      candidates = [this.createWorker()];
    }
    if (candidates.length === 0) {
      throw new UpstreamError('zcode 渠道并发已满', {
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

  private acquireSlot(worker: ZcodeWorker): void {
    this.totalActive += 1;
    this.activeByWorker.set(worker, (this.activeByWorker.get(worker) ?? 0) + 1);
  }

  private releaseSlot(
    worker: ZcodeWorker,
    gatewaySessionId: string,
    oneShot: boolean,
  ): void {
    this.totalActive = Math.max(0, this.totalActive - 1);
    const next = Math.max(0, (this.activeByWorker.get(worker) ?? 0) - 1);
    this.activeByWorker.set(worker, next);
    if (oneShot) this.sessionWorkers.delete(gatewaySessionId);
    if (next === 0) this.scheduleIdleStop(worker);
  }

  private scheduleIdleStop(worker: ZcodeWorker): void {
    if (this.closed) return;
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

  private async stopWorker(worker: ZcodeWorker): Promise<void> {
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

  listPendingQuestions(): PendingQuestionView[] {
    return [...this.pendingQuestions.values()].map((pending) => ({
      id: pending.id,
      providerId: this.config.id,
      gatewaySessionId: pending.runtime.gatewaySessionId,
      zcSessionId: pending.runtime.zcSessionId,
      ocSessionId: pending.runtime.zcSessionId,
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
    let result: unknown;
    if (pending.kind === 'form') {
      const answer = record.answer;
      if (!answer || typeof answer !== 'object') {
        throw new GatewayError('表单回答必须是对象', {
          status: 400,
          type: 'invalid_request_error',
        });
      }
      result = answer;
    } else {
      const decision = record.decision;
      if (decision !== 'once' && decision !== 'always' && decision !== 'reject') {
        throw new GatewayError('审批决定必须是 once / always / reject', {
          status: 400,
          type: 'invalid_request_error',
        });
      }
      result = { decision: decision === 'reject' ? 'deny' : 'allow' };
    }
    if (pending.respond) {
      try {
        pending.respond(result);
      } catch (error) {
        throw new GatewayError(`提交回答失败: ${(error as Error).message}`, {
          status: 502,
          type: 'upstream_error',
        });
      }
    }
    this.clearPending(pending, 'answered', raw);
    pending.runtime.suspended = false;
    this.store.updateZcTask(pending.runtime.taskId, 'running');
  }

  private clearPending(
    pending: PendingQuestion,
    status: 'answered' | 'expired',
    answer?: unknown,
  ): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingQuestions.delete(pending.id);
    pending.runtime.pendingQuestionIds.delete(pending.id);
    this.store.resolveZcQuestion(pending.id, status, answer);
  }

  private cleanupPendingForRuntime(runtime: TaskRuntime): void {
    for (const id of [...runtime.pendingQuestionIds]) {
      const pending = this.pendingQuestions.get(id);
      if (pending) {
        this.clearPending(pending, 'expired');
      }
    }
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

  private handleInteraction(
    worker: ZcodeWorker,
    request: ZcodeServerRequest,
  ): unknown {
    if (request.method === 'interaction/requestPermission') {
      return this.handlePermissionRequest(worker, request);
    }
    if (request.method === 'interaction/requestUserInput') {
      return this.handleUserInputRequest(worker, request);
    }
    // zcode CLI (v0.17.1) 对该应答做 strict zod 校验：nativeSearchEnhancementsEnabled
    // 必填 boolean，未知键（如 presentationSurface）会直接 ZodError 导致会话无法物化。
    if (request.method === 'session/requestRuntimePreferences') {
      return { nativeSearchEnhancementsEnabled: false };
    }
    return {};
  }

  private runtimeForParams(
    worker: ZcodeWorker,
    params: Record<string, unknown>,
  ): TaskRuntime | null {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    if (sessionId) {
      const runtime = this.runtimeByZcSession.get(sessionId);
      if (runtime && runtime.worker === worker) return runtime;
    }
    return null;
  }

  private handlePermissionRequest(
    worker: ZcodeWorker,
    request: ZcodeServerRequest,
  ): unknown | Promise<unknown> {
    const params = request.params;
    const runtime = this.runtimeForParams(worker, params);
    if (!runtime) {
      // 找不到上下文时保守拒绝，避免悬空授权
      return { decision: 'deny' };
    }
    if (this.config.mode === 'yolo') {
      return { decision: 'allow' };
    }
    const requestId =
      typeof params.requestId === 'string'
        ? params.requestId
        : `perm-${request.id}`;
    const existing = [...this.pendingQuestions.values()].find(
      (item) => item.runtime === runtime && item.requestId === requestId,
    );
    if (existing) {
      // 已在等待面板处理：挂起本次协议应答，等面板裁决
      return new Promise<unknown>((resolveAnswer) => {
        existing.respond = resolveAnswer;
      });
    }
    const toolName = typeof params.toolName === 'string' ? params.toolName : 'unknown';
    const reason = typeof params.reason === 'string' ? params.reason : '';
    const payload = {
      sessionId: params.sessionId ?? null,
      toolCallId: params.toolCallId ?? null,
      toolName,
      riskLevel: params.riskLevel ?? null,
      reason,
      input: params.input ?? null,
    };
    const pending = this.addQuestion(
      runtime,
      'permission',
      requestId,
      payload,
      `需要审批：${toolName}${reason ? `（${reason}）` : ''}。请到 Code2Api 面板「待处理提问」中允许或拒绝。`,
    );
    return new Promise<unknown>((resolveAnswer) => {
      pending.respond = resolveAnswer;
    });
  }

  private handleUserInputRequest(
    worker: ZcodeWorker,
    request: ZcodeServerRequest,
  ): unknown | Promise<unknown> {
    const params = request.params;
    const runtime = this.runtimeForParams(worker, params);
    if (!runtime) return {};
    const requestId =
      typeof params.requestId === 'string' ? params.requestId : `input-${request.id}`;
    const prompt = typeof params.prompt === 'string' ? params.prompt : '需要输入';
    const payload = {
      sessionId: params.sessionId ?? null,
      prompt,
      inputType: params.inputType ?? null,
      choices: params.choices ?? null,
    };
    const pending = this.addQuestion(
      runtime,
      'form',
      requestId,
      payload,
      `需要你的输入：${prompt}。请到 Code2Api 面板「待处理提问」中回答。`,
    );
    return new Promise<unknown>((resolveAnswer) => {
      pending.respond = resolveAnswer;
    });
  }

  private async ensureSession(
    worker: ZcodeWorker,
    gatewaySessionId: string,
    model: ModelConfig,
    ref: ModelRef,
    oneShot: boolean,
    workspace?: string,
  ): Promise<{ zcSessionId: string }> {
    let row = this.store.getZcSession(gatewaySessionId, this.config.id);
    if (row) {
      let alive = true;
      let needsResume = false;
      try {
        const state = await worker.request<{ state?: unknown }>(
          'session/lifecycle/getState',
          { sessionId: row.zcSessionId },
          15000,
        );
        if (
          typeof state.state === 'string' &&
          (state.state === 'faulted' || state.state === 'unloaded')
        ) {
          alive = state.state !== 'unloaded';
          needsResume = state.state === 'unloaded';
        }
      } catch (error) {
        if (error instanceof UpstreamError && error.category === 'timeout') {
          throw error;
        }
        // 只有明确的“会话不存在”才重建；方法不可用等其他错误保守放行
        const message = (error as Error).message ?? '';
        alive = !/session.*(not\s*exist|not\s*found|missing|invalid)|no such session/i.test(
          message,
        );
        if (!alive) {
          log.warn(`zcode 会话 ${row.zcSessionId} 已不存在，重建并重放账本`);
        }
      }
      if (!alive) {
        this.store.deleteZcSession(gatewaySessionId, this.config.id);
        this.store.resetZcLedgerDelivered(gatewaySessionId);
        row = null;
      } else {
        if (needsResume) {
          await worker.request(
            'session/resume',
            { sessionId: row.zcSessionId },
            30000,
          );
        }
        if (workspace && row.workspace) {
          const same =
            normalizePathForCompare(resolve(row.workspace)) ===
            normalizePathForCompare(workspace);
          if (!same) {
            throw new UpstreamError(
              `该会话已绑定工作区 ${row.workspace}，不能切换到 ${workspace}；请使用新的 x-code2api-session`,
              { category: 'bad_request', status: 400, retryable: false },
            );
          }
        }
        if (row.modelUpstream !== model.upstream) {
          await worker.request('session/setModel', {
            sessionId: row.zcSessionId,
            model: {
              providerId: ref.providerId,
              modelId: ref.modelId,
              ...(ref.reasoningLevel ? { options: { reasoningLevel: ref.reasoningLevel } } : {}),
            },
          });
          this.store.upsertZcSession({
            ...row,
            modelPublic: model.id,
            modelUpstream: model.upstream,
            updatedAt: Date.now(),
          });
        }
        return { zcSessionId: row.zcSessionId };
      }
    }

    const workspacePath = workspace ?? resolve(process.cwd(), this.config.workspace);
    const snapshot = await worker.request<Record<string, unknown>>('session/create', {
      workspace: {
        workspacePath,
        workspaceKey: workspacePath,
      },
      mode: this.config.mode,
      model: {
        providerId: ref.providerId,
        modelId: ref.modelId,
        ...(ref.reasoningLevel ? { options: { reasoningLevel: ref.reasoningLevel } } : {}),
      },
    });
    const sessionNode = snapshot.session as Record<string, unknown> | undefined;
    const zcSessionId =
      (sessionNode && typeof sessionNode.sessionId === 'string'
        ? sessionNode.sessionId
        : undefined) ??
      (typeof snapshot.sessionId === 'string' ? snapshot.sessionId : undefined);
    if (!zcSessionId) {
      throw new UpstreamError('zcode 创建会话失败：响应缺少 session id', {
        category: 'server',
        retryable: true,
      });
    }
    if (workspace) {
      log.info(`zcode 会话 ${zcSessionId} 工作区: ${workspace}`);
    }
    this.store.upsertZcSession({
      gatewaySessionId,
      providerId: this.config.id,
      zcSessionId,
      modelPublic: model.id,
      modelUpstream: model.upstream,
      workspace: workspacePath,
      oneShot,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { zcSessionId };
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
        .update(`zcode\u0000${base}\u0000${occurrence}`)
        .digest('hex');
      items.push({ msgId, role: message.role, text });
    }
    this.store.insertZcLedgerMessages(gatewaySessionId, items);

    let undelivered = this.store.getUndeliveredZcLedger(gatewaySessionId);
    if (undelivered.length === 0) {
      const lastUser = this.store.getLastUserZcLedger(gatewaySessionId);
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
    note: string,
  ): PendingQuestion {
    const existing = [...this.pendingQuestions.values()].find(
      (item) => item.requestId === requestId && item.runtime.taskId === runtime.taskId,
    );
    if (existing) return existing;
    const id = `zcq_${randomUUID()}`;
    const pending: PendingQuestion = {
      id,
      kind,
      requestId,
      runtime,
      payload,
      createdAt: Date.now(),
      timer: null,
      respond: null,
    };
    pending.timer = setTimeout(() => {
      const current = this.pendingQuestions.get(id);
      if (!current) return;
      if (current.respond) {
        try {
          current.respond(
            current.kind === 'permission' ? { decision: 'deny' } : { cancelled: true },
          );
        } catch {
          // 忽略应答失败
        }
      }
      this.clearPending(current, 'expired');
      runtime.lastError = '等待用户回答超时';
      void this.interrupt(runtime.worker, runtime.zcSessionId);
    }, this.config.questionTimeoutMs);
    this.pendingQuestions.set(id, pending);
    runtime.pendingQuestionIds.add(id);
    runtime.suspended = true;
    this.store.createZcQuestion({
      id,
      gatewaySessionId: runtime.gatewaySessionId,
      providerId: this.config.id,
      zcSessionId: runtime.zcSessionId,
      kind,
      requestId,
      payload,
    });
    this.store.updateZcTask(runtime.taskId, 'suspended');
    this.emitNote(runtime, () => {}, note);
    return pending;
  }

  private handleEvent(
    runtime: TaskRuntime,
    event: ZcodeProtocolEvent,
    emit: (event: StreamEvent) => void,
    resolveOutcome: (outcome: TaskOutcome) => void,
  ): void {
    const payload = event.payload ?? {};
    switch (event.type) {
      case 'part.delta': {
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (!delta) break;
        const field = typeof payload.field === 'string' ? payload.field : 'text';
        if (field === 'text') {
          runtime.text += delta;
          emit({ type: 'text_delta', text: delta });
        } else if (field === 'reasoning') {
          runtime.thinking += delta;
          emit({ type: 'thinking_delta', text: delta });
        }
        break;
      }
      case 'turn.completed': {
        const rawTurnUsage = (payload.usage ?? {}) as Record<string, unknown>;
        // 累加 = 上游真实消耗（记账）；本轮快照 = 当前对话规模（客户端可见）。
        mapUsage(runtime.usage, rawTurnUsage);
        const turnUsage: Usage = {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimated: false,
        };
        mapUsage(turnUsage, rawTurnUsage);
        runtime.lastTurnUsage = turnUsage;
        const response =
          typeof payload.response === 'string' ? payload.response : '';
        if (response && !runtime.text) {
          runtime.text = response;
          emit({ type: 'text_delta', text: response });
        }
        const resultType =
          typeof payload.resultType === 'string' ? payload.resultType : 'success';
        if (resultType === 'success') {
          runtime.finish = 'stop';
          resolveOutcome('succeeded');
        } else if (resultType === 'cancelled') {
          resolveOutcome('interrupted');
        } else {
          runtime.lastError =
            RESULT_TYPE_MESSAGES[resultType] ?? `zcode 任务失败：${resultType}`;
          runtime.finish = 'error';
          resolveOutcome('failed');
        }
        break;
      }
      case 'turn.failed': {
        runtime.lastError = eventErrorMessage(payload);
        runtime.finish = 'error';
        resolveOutcome('failed');
        break;
      }
      case 'permission.requested': {
        // 通知形态的权限请求：真正要应答的是 interaction/requestPermission。
        // 这里只在没有任何 pending 时记录 note，避免重复提问。
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
        const alreadyPending = [...this.pendingQuestions.values()].some(
          (item) => item.runtime === runtime && (!requestId || item.requestId === requestId),
        );
        if (!alreadyPending) {
          const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
          this.emitNote(
            runtime,
            emit,
            `需要审批：${toolName}。请到 Code2Api 面板「待处理提问」中允许或拒绝。`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  private async interrupt(worker: ZcodeWorker, sessionId: string): Promise<void> {
    try {
      await worker.request('session/stop', { sessionId }, 15000);
    } catch (error) {
      log.warn(`zcode 中断失败: ${(error as Error).message}`);
    }
  }

  private async executeTask(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
    emit: (event: StreamEvent) => void,
  ): Promise<CanonicalResponse> {
    if (this.closed) {
      throw new UpstreamError('zcode 渠道已关闭', { category: 'server', retryable: false });
    }
    const ref = parseModelRef(model, request.reasoningEffort);
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
    const taskId = `zctask_${randomUUID()}`;
    this.activeSessions.set(gatewaySessionId, taskId);

    let runtime: TaskRuntime | null = null;
    let poolWorker: ZcodeWorker | null = null;
    let slotAcquired = false;
    let unsubscribeEvents: (() => void) | null = null;
    let unsubscribeExit: (() => void) | null = null;
    let resolveOutcome!: (outcome: TaskOutcome) => void;
    const completion = new Promise<TaskOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let timeoutTimer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    let outcomeResolved = false;
    const resolveOnce = (outcome: TaskOutcome) => {
      if (outcomeResolved) return;
      outcomeResolved = true;
      resolveOutcome(outcome);
    };

    try {
      const worker = await this.pickWorker(gatewaySessionId, oneShot);
      poolWorker = worker;
      this.acquireSlot(worker);
      slotAcquired = true;
      await worker.ensureStarted();
      const { zcSessionId } = await this.ensureSession(
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
        zcSessionId,
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
        lastTurnUsage: null,
        lastError: null,
        suspended: false,
        pendingQuestionIds: new Set(),
      };
      this.runtimeByZcSession.set(zcSessionId, runtime);
      this.store.recordZcTask({
        id: taskId,
        gatewaySessionId,
        providerId: this.config.id,
        zcSessionId,
        state: 'running',
        createdAt: Date.now(),
      });
      unsubscribeEvents = worker.subscribeSession(zcSessionId, (event) =>
        this.handleEvent(runtime as TaskRuntime, event, emit, resolveOnce),
      );
      unsubscribeExit = worker.onExit((message) => {
        if (runtime) runtime.lastError = message;
        resolveOnce('failed');
      });

      const promptText = this.buildPrompt(gatewaySessionId, request);
      await worker.request('session/send', {
        sessionId: zcSessionId,
        content: promptText,
      });
      this.store.markAllZcLedgerDelivered(gatewaySessionId);

      const timeout = new Promise<'timeout'>((resolveTimeout) => {
        timeoutTimer = setTimeout(() => resolveTimeout('timeout'), this.config.taskTimeoutMs);
      });
      const abortPromise = new Promise<'aborted'>((resolveAbort) => {
        abortListener = () => resolveAbort('aborted');
        ctx.signal.addEventListener('abort', abortListener, { once: true });
      });
      const outcome = await Promise.race([completion, timeout, abortPromise]);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }

      if (outcome === 'timeout') {
        await this.interrupt(worker, zcSessionId);
        throw new UpstreamError('zcode 任务执行超时', {
          category: 'timeout',
          status: 504,
          retryable: false,
        });
      }
      if (outcome === 'aborted') {
        await this.interrupt(worker, zcSessionId);
        throw new UpstreamError('client aborted', {
          category: 'cancelled',
          retryable: false,
        });
      }
      if (!runtime) {
        throw new UpstreamError('zcode 任务运行时丢失', { category: 'server' });
      }
      const runtimeDone = runtime;
      if (outcome === 'failed') {
        throw new UpstreamError(runtimeDone.lastError ?? 'zcode 任务失败', {
          category: 'server',
          retryable: false,
        });
      }
      if (outcome === 'interrupted') {
        throw new UpstreamError('client aborted', {
          category: 'cancelled',
          retryable: false,
        });
      }

      // 客户端可见 usage = 末轮快照（当前对话规模）；记账用累加值（upstreamUsage）。
      const clientUsage = runtimeDone.lastTurnUsage ?? runtimeDone.usage;
      const response = {
        id: `zcode-${taskId}`,
        model: model.id,
        text: runtimeDone.text,
        thinking: runtimeDone.thinking || undefined,
        toolCalls: [],
        stopReason: runtimeDone.finish,
        usage: clientUsage,
        upstreamUsage: runtimeDone.usage,
      };
      emit({ type: 'usage', usage: clientUsage, upstreamUsage: runtimeDone.usage });
      emit({ type: 'finish', reason: runtimeDone.finish });
      this.store.appendAssistantZcLedger(gatewaySessionId, runtimeDone.text);
      this.store.updateZcTask(taskId, 'finished', null, runtimeDone.usage);
      return response;
    } catch (error) {
      if (runtime) {
        const state = ctx.signal.aborted ? 'interrupted' : 'failed';
        this.store.updateZcTask(taskId, state, (error as Error).message, runtime.usage);
        this.cleanupPendingForRuntime(runtime);
      }
      throw error;
    } finally {
      if (abortListener) ctx.signal.removeEventListener('abort', abortListener);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (runtime) this.runtimeByZcSession.delete(runtime.zcSessionId);
      if (unsubscribeEvents) unsubscribeEvents();
      if (unsubscribeExit) unsubscribeExit();
      this.activeSessions.delete(gatewaySessionId);
      if (runtime?.oneShot) {
        void runtime.worker
          .request('session/close', { sessionId: runtime.zcSessionId }, 10000)
          .catch(() => {});
        this.store.deleteZcSession(gatewaySessionId, this.config.id);
      }
      if (poolWorker && slotAcquired) {
        this.releaseSlot(poolWorker, gatewaySessionId, oneShot);
      }
    }
  }
}

// 注意：addQuestion 的 note 仅写入流（交互路径下 emit 为空操作）。
