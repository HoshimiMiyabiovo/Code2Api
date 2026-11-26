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
import type { ModelConfig, QoderProviderConfig } from '../config.js';
import { GatewayError, UpstreamError } from '../errors.js';
import { log } from '../logger.js';
import type { Store } from '../store/db.js';
import {
  EventQueue,
  normalizePathForCompare,
  resolveWorkspace,
} from './opencode.js';
import {
  QoderWorker,
  type QoderModelInfo,
  type QoderProtocolFrame,
  type QoderServerRequest,
  type QoderWorkerSnapshot,
} from './qoder-worker.js';
import type { ChatContext, ProviderAdapter } from './types.js';

type TaskOutcome = 'succeeded' | 'failed' | 'interrupted';

interface TaskRuntime {
  taskId: string;
  worker: QoderWorker;
  gatewaySessionId: string;
  qdSessionId: string;
  oneShot: boolean;
  startTime: number;
  text: string;
  thinking: string;
  finish: StopReason;
  usage: Usage;
  /** 最后一次 result 帧的用量快照 = 客户端可见的「当前对话规模」（usage 字段语义）。 */
  lastResultUsage: Usage | null;
  lastError: string | null;
  suspended: boolean;
  pendingQuestionIds: Set<string>;
  /** 本轮是否已用 stream_event/流式帧吐过增量（决定 assistant 兜底全文是否 emit）。 */
  streamedDeltas: boolean;
  /** 本轮 assistant 兜底全文是否已 emit（防重复）。 */
  assistantFallbackEmitted: boolean;
}

interface PendingQuestion {
  id: string;
  kind: 'form' | 'permission';
  requestId: string;
  runtime: TaskRuntime;
  payload: unknown;
  createdAt: number;
  timer: NodeJS.Timeout | null;
  /** 反向请求的应答回调；回答后写回 control_response。 */
  respond: ((result: unknown) => void) | null;
}

export interface PendingQuestionView {
  id: string;
  providerId: string;
  gatewaySessionId: string;
  qdSessionId: string;
  /** 面板兼容字段：与 opencode 的 PendingQuestionView 同名。 */
  ocSessionId: string;
  kind: 'form' | 'permission';
  payload: unknown;
  createdAt: number;
}

function eventErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.message === 'string') return rec.message;
    if (typeof rec.type === 'string') return rec.type;
    return JSON.stringify(value).slice(0, 500);
  }
  return 'qoder 任务失败';
}

/** qoder（Claude Agent SDK 衍生）usage 兼容 snake_case / camelCase 两种字段名。 */
function mapUsage(usage: Usage, raw: Record<string, unknown> | undefined): void {
  if (!raw) return;
  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
  };
  usage.inputTokens += num('input_tokens', 'inputTokens', 'prompt_tokens');
  usage.outputTokens += num('output_tokens', 'outputTokens', 'completion_tokens');
  usage.reasoningTokens = (usage.reasoningTokens ?? 0) + num('reasoning_tokens', 'reasoningTokens');
  usage.cacheReadTokens =
    (usage.cacheReadTokens ?? 0) + num('cache_read_input_tokens', 'cacheReadTokens', 'cache_read_tokens');
  usage.cacheWriteTokens =
    (usage.cacheWriteTokens ?? 0) + num('cache_creation_input_tokens', 'cacheWriteTokens', 'cache_creation_tokens');
}

function assistantTextOf(frame: QoderProtocolFrame): string {
  const message = frame.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts.join('');
}

/**
 * 面板「探测上游」：用草稿配置临时拉起一个 qoder daemon，读一次 daemon.get_models 后关停。
 * 只读目录、不 open_session、不消耗模型额度；未保存的渠道也能探测。
 */
export async function probeQoderModels(
  config: QoderProviderConfig,
  timeoutMs = 20000,
): Promise<QoderModelInfo[]> {
  const worker = new QoderWorker(config);
  try {
    await worker.ensureStarted();
    return await worker.getModels({ timeoutMs });
  } finally {
    await worker.stop().catch(() => {
      // 探测收尾失败不影响结果；进程已被 killChild 兜底
    });
  }
}

export class QoderAdapter implements ProviderAdapter {
  private readonly workers: QoderWorker[] = [];
  private readonly sessionWorkers = new Map<string, QoderWorker>();
  private readonly activeByWorker = new Map<QoderWorker, number>();
  private readonly idleTimers = new Map<QoderWorker, NodeJS.Timeout>();
  private totalActive = 0;
  private readonly activeSessions = new Map<string, string>();
  private readonly runtimeByQdSession = new Map<string, TaskRuntime>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private closed = false;

  constructor(
    private readonly config: QoderProviderConfig,
    private readonly store: Store,
  ) {}

  private createWorker(): QoderWorker {
    const worker = new QoderWorker(this.config);
    worker.setInteractionHandler((request) => this.handleInteraction(worker, request));
    this.workers.push(worker);
    this.activeByWorker.set(worker, 0);
    return worker;
  }

  private getAnyWorker(): QoderWorker {
    const ready = this.workers.find((worker) => worker.isReady());
    if (ready) return ready;
    const starting = this.workers.find((worker) => worker.snapshot().state !== 'stopped');
    if (starting) return starting;
    return this.createWorker();
  }

  workerSnapshot(): QoderWorkerSnapshot {
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
    workers: QoderWorkerSnapshot[];
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
  ): Promise<QoderWorker> {
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
      throw new UpstreamError('qoder 渠道并发已满', {
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
      throw new UpstreamError('qoder 渠道并发已满', {
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

  private acquireSlot(worker: QoderWorker): void {
    this.totalActive += 1;
    this.activeByWorker.set(worker, (this.activeByWorker.get(worker) ?? 0) + 1);
  }

  private releaseSlot(
    worker: QoderWorker,
    gatewaySessionId: string,
    oneShot: boolean,
  ): void {
    this.totalActive = Math.max(0, this.totalActive - 1);
    const next = Math.max(0, (this.activeByWorker.get(worker) ?? 0) - 1);
    this.activeByWorker.set(worker, next);
    if (oneShot) this.sessionWorkers.delete(gatewaySessionId);
    if (next === 0) this.scheduleIdleStop(worker);
  }

  private scheduleIdleStop(worker: QoderWorker): void {
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

  private async stopWorker(worker: QoderWorker): Promise<void> {
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
      qdSessionId: pending.runtime.qdSessionId,
      ocSessionId: pending.runtime.qdSessionId,
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
      result =
        decision === 'reject'
          ? { behavior: 'deny', message: '用户在面板拒绝了该工具调用' }
          : { behavior: 'allow' };
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
    this.store.updateQdTask(pending.runtime.taskId, 'running');
  }

  private clearPending(
    pending: PendingQuestion,
    status: 'answered' | 'expired',
    answer?: unknown,
  ): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingQuestions.delete(pending.id);
    pending.runtime.pendingQuestionIds.delete(pending.id);
    this.store.resolveQdQuestion(pending.id, status, answer);
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
    worker: QoderWorker,
    request: QoderServerRequest,
  ): unknown {
    if (request.type === 'can_use_tool') {
      return this.handlePermissionRequest(worker, request);
    }
    if (request.type === 'elicitation') {
      return this.handleElicitation(worker, request);
    }
    // 保守兜底：无法提供的反向请求回 error，避免 CLI 悬挂等待
    if (
      request.type === 'fetch_job_token' ||
      request.type === 'fetch_service_account_token'
    ) {
      throw new Error('网关无法提供 qoder job token（IDE 宿主能力），请改用 PAT 或 CLI 登录态');
    }
    if (request.type === 'mcp_message') {
      return { mcp_response: {} };
    }
    if (request.type === 'hook_callback') {
      return {};
    }
    throw new Error(`网关未支持 qoder 反向请求 ${request.type}`);
  }

  private runtimeForRequest(
    worker: QoderWorker,
    request: QoderServerRequest,
  ): TaskRuntime | null {
    if (request.sessionId) {
      const runtime = this.runtimeByQdSession.get(request.sessionId);
      if (runtime && runtime.worker === worker) return runtime;
    }
    return null;
  }

  private handlePermissionRequest(
    worker: QoderWorker,
    request: QoderServerRequest,
  ): unknown | Promise<unknown> {
    const payload = request.payload;
    const runtime = this.runtimeForRequest(worker, request);
    if (!runtime) {
      // 找不到上下文时保守拒绝，避免悬空授权
      return { behavior: 'deny', message: '找不到对应的网关会话' };
    }
    if (this.config.mode === 'bypass_permissions') {
      return { behavior: 'allow' };
    }
    const requestId =
      typeof payload.tool_use_id === 'string' ? payload.tool_use_id : `perm-${request.requestId}`;
    const existing = [...this.pendingQuestions.values()].find(
      (item) => item.runtime === runtime && item.requestId === requestId,
    );
    if (existing) {
      // 已在等待面板处理：挂起本次协议应答，等面板裁决
      return new Promise<unknown>((resolveAnswer) => {
        existing.respond = resolveAnswer;
      });
    }
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown';
    const reason =
      typeof payload.decision_reason === 'string' ? payload.decision_reason : '';
    const questionPayload = {
      sessionId: request.sessionId ?? null,
      toolCallId: payload.tool_use_id ?? null,
      toolName,
      reason,
      input: payload.input ?? null,
      suggestions: payload.permission_suggestions ?? payload.suggestions ?? null,
    };
    const pending = this.addQuestion(
      runtime,
      'permission',
      requestId,
      questionPayload,
      `需要审批：${toolName}${reason ? `（${reason}）` : ''}。请到 Code2Api 面板「待处理提问」中允许或拒绝。`,
    );
    return new Promise<unknown>((resolveAnswer) => {
      pending.respond = resolveAnswer;
    });
  }

  private handleElicitation(
    worker: QoderWorker,
    request: QoderServerRequest,
  ): unknown {
    // v1 不支持 MCP elicitation 交互：直接取消，避免任务悬挂
    const runtime = this.runtimeForRequest(worker, request);
    if (runtime) {
      const title =
        typeof request.payload.title === 'string'
          ? request.payload.title
          : typeof request.payload.message === 'string'
            ? request.payload.message
            : 'elicitation';
      this.emitNote(
        runtime,
        () => {},
        `已自动取消 MCP 交互请求：${title}`,
      );
    }
    return { action: 'cancel' };
  }

  private async ensureSession(
    worker: QoderWorker,
    gatewaySessionId: string,
    model: ModelConfig,
    oneShot: boolean,
    workspace?: string,
  ): Promise<{ qdSessionId: string }> {
    let row = this.store.getQdSession(gatewaySessionId, this.config.id);
    if (row) {
      let alive = true;
      try {
        const listing = await worker.request(
          'daemon.list_sessions',
          {},
          { timeoutMs: 15000 },
        );
        const ids = extractSessionIds(listing);
        // 应答结构可辨认但不含该会话 → 已失效，重建并重放账本；
        // 结构不可辨认（CLI 升级等）时保守放行
        if (ids && !ids.includes(row.qdSessionId)) {
          alive = false;
          log.warn(`qoder 会话 ${row.qdSessionId} 已不存在，重建并重放账本`);
        }
      } catch (error) {
        if (error instanceof UpstreamError && error.category === 'timeout') {
          throw error;
        }
        // 其他协议错误保守放行（与 zcode 同策略）
      }
      if (!alive) {
        this.store.deleteQdSession(gatewaySessionId, this.config.id);
        this.store.resetQdLedgerDelivered(gatewaySessionId);
        row = null;
      } else {
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
          // 模型变更：query 级 set_model（真实字段契约待冒烟校准，fake 用 {model}）
          await worker.request(
            'set_model',
            { model: model.upstream },
            { sessionId: row.qdSessionId, timeoutMs: 30000 },
          );
          this.store.upsertQdSession({
            ...row,
            modelPublic: model.id,
            modelUpstream: model.upstream,
            updatedAt: Date.now(),
          });
        }
        return { qdSessionId: row.qdSessionId };
      }
    }

    const workspacePath = workspace ?? resolve(process.cwd(), this.config.workspace);
    const result = await worker.request<{ session_id?: string }>(
      'daemon.open_session',
      {
        cwd: workspacePath,
        worker_args: [
          '--model',
          model.upstream,
          '--permission-mode',
          this.config.mode,
          '--include-partial-messages',
        ],
      },
      { timeoutMs: 30000 },
    );
    const qdSessionId =
      typeof result.session_id === 'string' && result.session_id
        ? result.session_id
        : undefined;
    if (!qdSessionId) {
      throw new UpstreamError('qoder 创建会话失败：响应缺少 session_id', {
        category: 'server',
        retryable: true,
      });
    }
    await this.initializeSessionQuietly(worker, qdSessionId);
    if (workspace) {
      log.info(`qoder 会话 ${qdSessionId} 工作区: ${workspace}`);
    }
    this.store.upsertQdSession({
      gatewaySessionId,
      providerId: this.config.id,
      qdSessionId,
      modelPublic: model.id,
      modelUpstream: model.upstream,
      workspace: workspacePath,
      oneShot,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { qdSessionId };
  }

  /**
   * open_session 后补一条 query 级 initialize（SDK 每个会话都会发）。
   * 必填字段契约未证实，失败仅告警不阻断（真实冒烟校准点）。
   */
  private async initializeSessionQuietly(
    worker: QoderWorker,
    qdSessionId: string,
  ): Promise<void> {
    try {
      await worker.request(
        'initialize',
        {
          modelPolicyProvider: 'code2api',
          initializeTimeoutMs: 120000,
        },
        { sessionId: qdSessionId, timeoutMs: 20000 },
      );
    } catch (error) {
      log.warn(`qoder 会话 ${qdSessionId} initialize 应答异常（容忍）: ${(error as Error).message}`);
    }
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
        .update(`qoder\u0000${base}\u0000${occurrence}`)
        .digest('hex');
      items.push({ msgId, role: message.role, text });
    }
    this.store.insertQdLedgerMessages(gatewaySessionId, items);

    let undelivered = this.store.getUndeliveredQdLedger(gatewaySessionId);
    if (undelivered.length === 0) {
      const lastUser = this.store.getLastUserQdLedger(gatewaySessionId);
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
    const id = `qdq_${randomUUID()}`;
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
            current.kind === 'permission'
              ? { behavior: 'deny', message: '等待用户审批超时，自动拒绝' }
              : { action: 'cancel' },
          );
        } catch {
          // 忽略应答失败
        }
      }
      this.clearPending(current, 'expired');
      runtime.lastError = '等待用户回答超时';
      void this.interrupt(runtime.worker, runtime.qdSessionId);
    }, this.config.questionTimeoutMs);
    this.pendingQuestions.set(id, pending);
    runtime.pendingQuestionIds.add(id);
    runtime.suspended = true;
    this.store.createQdQuestion({
      id,
      gatewaySessionId: runtime.gatewaySessionId,
      providerId: this.config.id,
      qdSessionId: runtime.qdSessionId,
      kind,
      requestId,
      payload,
    });
    this.store.updateQdTask(runtime.taskId, 'suspended');
    this.emitNote(runtime, () => {}, note);
    return pending;
  }

  private handleEvent(
    runtime: TaskRuntime,
    frame: QoderProtocolFrame,
    emit: (event: StreamEvent) => void,
    resolveOutcome: (outcome: TaskOutcome) => void,
  ): void {
    switch (frame.type) {
      case 'stream_event': {
        const event = frame.event as Record<string, unknown> | undefined;
        if (!event || typeof event !== 'object') break;
        const delta =
          event.delta && typeof event.delta === 'object'
            ? (event.delta as Record<string, unknown>)
            : null;
        if (delta) {
          // Claude stream-json 形状：delta 自身即 {type:'text_delta'|'thinking_delta', text|thinking}
          const deltaType = typeof delta.type === 'string' ? delta.type : '';
          const nestedText = delta.text_delta as Record<string, unknown> | undefined;
          const nestedThinking = delta.thinking_delta as Record<string, unknown> | undefined;
          const text =
            deltaType === 'text_delta' && typeof delta.text === 'string'
              ? delta.text
              : typeof nestedText?.text === 'string'
                ? nestedText.text
                : '';
          const thinking =
            deltaType === 'thinking_delta' && typeof delta.thinking === 'string'
              ? delta.thinking
              : typeof nestedThinking?.thinking === 'string'
                ? nestedThinking.thinking
                : '';
          if (text) {
            runtime.text += text;
            runtime.streamedDeltas = true;
            emit({ type: 'text_delta', text });
            break;
          }
          if (thinking) {
            runtime.thinking += thinking;
            runtime.streamedDeltas = true;
            emit({ type: 'thinking_delta', text: thinking });
            break;
          }
        }
        break;
      }
      case 'streamlined_text': {
        const text = typeof frame.text === 'string' ? frame.text : '';
        if (text) {
          runtime.text += text;
          runtime.streamedDeltas = true;
          emit({ type: 'text_delta', text });
        }
        break;
      }
      case 'assistant': {
        // 兜底全文：仅当本轮没有任何流式增量时 emit，防止与 delta 重复
        const message = frame.message as Record<string, unknown> | undefined;
        if (message && message.role === 'assistant' && !runtime.streamedDeltas && !runtime.assistantFallbackEmitted) {
          const text = assistantTextOf(frame);
          if (text) {
            runtime.text += text;
            runtime.assistantFallbackEmitted = true;
            emit({ type: 'text_delta', text });
          }
        }
        break;
      }
      case 'result': {
        const rawUsage =
          frame.usage && typeof frame.usage === 'object' && !Array.isArray(frame.usage)
            ? (frame.usage as Record<string, unknown>)
            : undefined;
        // 累加 = 上游真实消耗（记账）；result 快照 = 当前对话规模（客户端可见）。
        mapUsage(runtime.usage, rawUsage);
        const resultUsage: Usage = {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimated: false,
        };
        mapUsage(resultUsage, rawUsage);
        runtime.lastResultUsage = resultUsage;
        const isError = frame.is_error === true || frame.subtype === 'error';
        if (isError) {
          runtime.lastError =
            eventErrorMessage(frame.result ?? frame.errors ?? frame.error) ?? 'qoder 任务失败';
          runtime.finish = 'error';
          resolveOutcome('failed');
          break;
        }
        const terminalReason = typeof frame.terminal_reason === 'string' ? frame.terminal_reason : '';
        const resultText = typeof frame.result === 'string' ? frame.result : '';
        if (resultText && !runtime.text) {
          runtime.text = resultText;
          emit({ type: 'text_delta', text: resultText });
        }
        if (terminalReason.startsWith('abort')) {
          resolveOutcome('interrupted');
        } else {
          runtime.finish = 'stop';
          resolveOutcome('succeeded');
        }
        break;
      }
      case 'system': {
        if (frame.subtype === 'auth_status') {
          const error = frame.error ?? frame.data;
          if (error) {
            runtime.lastError = `qoder 认证失败: ${eventErrorMessage(error)}`;
            runtime.finish = 'error';
            resolveOutcome('failed');
          }
        }
        break;
      }
      case 'status_event': {
        // {status:"daemon.session_updated", data:{state:"failed", error}}
        if (frame.status === 'daemon.session_updated') {
          const data = frame.data as Record<string, unknown> | undefined;
          if (data && data.state === 'failed') {
            runtime.lastError = eventErrorMessage(data.error ?? data);
            runtime.finish = 'error';
            resolveOutcome('failed');
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private async interrupt(worker: QoderWorker, sessionId: string): Promise<void> {
    try {
      await worker.request('interrupt', {}, { sessionId, timeoutMs: 15000 });
    } catch (error) {
      log.warn(`qoder 中断失败: ${(error as Error).message}`);
    }
  }

  private async executeTask(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
    emit: (event: StreamEvent) => void,
  ): Promise<CanonicalResponse> {
    if (this.closed) {
      throw new UpstreamError('qoder 渠道已关闭', { category: 'server', retryable: false });
    }
    if (!model.upstream) {
      throw new UpstreamError(
        `qoder 模型 ${model.id} 缺少 upstream 配置（应为 CLI 可识别的模型标识）`,
        { category: 'bad_request', retryable: false },
      );
    }
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
    const taskId = `qdtask_${randomUUID()}`;
    this.activeSessions.set(gatewaySessionId, taskId);

    let runtime: TaskRuntime | null = null;
    let poolWorker: QoderWorker | null = null;
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
      const { qdSessionId } = await this.ensureSession(
        worker,
        gatewaySessionId,
        model,
        oneShot,
        workspace,
      );
      runtime = {
        taskId,
        worker,
        gatewaySessionId,
        qdSessionId,
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
        lastResultUsage: null,
        lastError: null,
        suspended: false,
        pendingQuestionIds: new Set(),
        streamedDeltas: false,
        assistantFallbackEmitted: false,
      };
      this.runtimeByQdSession.set(qdSessionId, runtime);
      this.store.recordQdTask({
        id: taskId,
        gatewaySessionId,
        providerId: this.config.id,
        qdSessionId,
        state: 'running',
        createdAt: Date.now(),
      });
      unsubscribeEvents = worker.subscribeSession(qdSessionId, (frame) =>
        this.handleEvent(runtime as TaskRuntime, frame, emit, resolveOnce),
      );
      unsubscribeExit = worker.onExit((message) => {
        if (runtime) runtime.lastError = message;
        resolveOnce('failed');
      });

      const promptText = this.buildPrompt(gatewaySessionId, request);
      worker.sendUserMessage(qdSessionId, promptText);
      this.store.markAllQdLedgerDelivered(gatewaySessionId);

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
        await this.interrupt(worker, qdSessionId);
        throw new UpstreamError('qoder 任务执行超时', {
          category: 'timeout',
          status: 504,
          retryable: false,
        });
      }
      if (outcome === 'aborted') {
        await this.interrupt(worker, qdSessionId);
        throw new UpstreamError('client aborted', {
          category: 'cancelled',
          retryable: false,
        });
      }
      if (!runtime) {
        throw new UpstreamError('qoder 任务运行时丢失', { category: 'server' });
      }
      const runtimeDone = runtime;
      if (outcome === 'failed') {
        throw new UpstreamError(runtimeDone.lastError ?? 'qoder 任务失败', {
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

      // 客户端可见 usage = result 快照（当前对话规模）；记账用累加值（upstreamUsage）。
      const clientUsage = runtimeDone.lastResultUsage ?? runtimeDone.usage;
      const response = {
        id: `qoder-${taskId}`,
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
      this.store.appendAssistantQdLedger(gatewaySessionId, runtimeDone.text);
      this.store.updateQdTask(taskId, 'finished', null, runtimeDone.usage);
      return response;
    } catch (error) {
      if (runtime) {
        const state = ctx.signal.aborted ? 'interrupted' : 'failed';
        this.store.updateQdTask(taskId, state, (error as Error).message, runtime.usage);
        this.cleanupPendingForRuntime(runtime);
      }
      throw error;
    } finally {
      if (abortListener) ctx.signal.removeEventListener('abort', abortListener);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (runtime) this.runtimeByQdSession.delete(runtime.qdSessionId);
      if (unsubscribeEvents) unsubscribeEvents();
      if (unsubscribeExit) unsubscribeExit();
      this.activeSessions.delete(gatewaySessionId);
      if (runtime?.oneShot) {
        // 真实 daemon 从 control_request 信封读 session_id（payload 里的同名字段只是兼容 fake/旧版）。
        void runtime.worker
          .request(
            'daemon.close_session',
            { session_id: runtime.qdSessionId },
            { sessionId: runtime.qdSessionId, timeoutMs: 10000 },
          )
          .catch(() => {});
        this.store.deleteQdSession(gatewaySessionId, this.config.id);
      }
      if (poolWorker && slotAcquired) {
        this.releaseSlot(poolWorker, gatewaySessionId, oneShot);
      }
    }
  }
}

/** 从 daemon.list_sessions 应答中宽容地提取会话 id 列表；结构不可辨认时返回 undefined。 */
function extractSessionIds(result: Record<string, unknown>): string[] | undefined {
  const container =
    (result.sessions as unknown) ??
    ((result.response as Record<string, unknown> | undefined)?.sessions as unknown) ??
    null;
  if (!Array.isArray(container)) return undefined;
  const ids: string[] = [];
  for (const item of container) {
    if (typeof item === 'string') {
      ids.push(item);
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      // 0.5.17 daemon.list_sessions 返回 {sessions:[{local_session_id,...}]}；
      // 其余字段名是旧版/fake 兼容。
      const id =
        rec.local_session_id ?? rec.session_id ?? rec.sessionId ?? rec.id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

// 注意：addQuestion 的 note 仅写入流（交互路径下 emit 为空操作）。
