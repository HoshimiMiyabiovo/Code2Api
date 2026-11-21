import type {
  CanonicalRequest,
  CanonicalResponse,
  CapabilityRequirement,
  StreamEvent,
} from '../canonical.js';
import { estimateRequestTokens } from '../canonical.js';
import type {
  CooldownConfig,
  ModelConfig,
  ModelPricing,
  RetryCategory,
  RetryPolicyConfig,
} from '../config.js';
import { ClientAbortError, GatewayError, UpstreamError, isAbortError, type FailureCategory } from '../errors.js';
import { log } from '../logger.js';
import type { ModelEntry, ProviderRuntime, Registry } from '../providers/registry.js';
import type { KeyRuntime } from './keys.js';
import { isModelBlacklisted, resolveModelAlias } from './model-rules.js';

interface Candidate {
  provider: ProviderRuntime;
  model: ModelConfig;
  key: KeyRuntime;
}

function satisfiesCapabilities(
  model: ModelConfig,
  requires: CapabilityRequirement,
): boolean {
  if (requires.tools && !model.capabilities.tools) return false;
  if (requires.vision && !model.capabilities.vision) return false;
  if (requires.reasoning && !model.capabilities.reasoning) return false;
  return true;
}

function describeRequirements(requires: CapabilityRequirement): string {
  const parts: string[] = [];
  if (requires.tools) parts.push('tools');
  if (requires.vision) parts.push('vision');
  if (requires.reasoning) parts.push('reasoning');
  return parts.join('、') || '无';
}

function jitteredBackoff(policy: RetryPolicyConfig, retry: number): number {
  const exponential = Math.min(
    policy.initialDelayMs * 2 ** Math.min(retry - 1, 10),
    policy.maxDelayMs,
  );
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * Math.random();
  return Math.min(exponential * jitter, policy.maxDelayMs);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ClientAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new ClientAbortError());
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function coolingExhausted(
  error: GatewayError,
  attempts: number,
  retries: number,
  waitedMs: number,
): GatewayError {
  const detail =
    attempts > 0 || retries > 0
      ? `（已重试等待 ${retries} 轮共 ${Math.round(waitedMs)}ms，本轮上游尝试 ${attempts} 次）`
      : '（渠道冷却剩余时长超出单请求等待预算，本轮未尝试上游）';
  return new GatewayError(`${error.message}${detail}`, {
    status: error.status,
    type: error.type,
    code: error.code,
    retryAfterMs: error.retryAfterMs,
    retryAfterSeconds: error.retryAfterSeconds,
    attempts,
  });
}

export interface NonStreamOutcome {
  response: CanonicalResponse;
  providerId: string;
  keyLabel: string;
  upstreamModel: string;
  pricing?: ModelPricing;
  attempts: number;
  latencyMs: number;
}

export interface StreamOutcome {
  first: StreamEvent;
  events: AsyncGenerator<StreamEvent, void, void>;
  providerId: string;
  keyLabel: string;
  upstreamModel: string;
  pricing?: ModelPricing;
  attempts: number;
  ttfbMs: number;
}

export interface AttemptFailureInfo {
  providerId: string;
  keyLabel: string;
  category: FailureCategory;
  status?: number;
  message: string;
}

export interface ProviderAvailability {
  isExhausted(providerId: string): boolean;
  retryAfterSeconds(providerId: string): number | undefined;
}

function statusFor(error: UpstreamError): number {
  switch (error.category) {
    case 'bad_request':
      return 400;
    case 'model_not_found':
      return 404;
    case 'rate_limit':
      return 429;
    case 'payment':
      return 402;
    case 'timeout':
      return 504;
    case 'busy':
      return 409;
    default:
      return 502;
  }
}

function typeFor(status: number): string {
  if (status === 400 || status === 404) return 'invalid_request_error';
  if (status === 409) return 'session_busy';
  if (status === 429) return 'rate_limit_error';
  if (status === 402) return 'insufficient_quota';
  return 'upstream_error';
}

export class Router {
  constructor(
    private readonly registry: Registry,
    private readonly maxAttempts: number,
    private readonly cooldowns: CooldownConfig,
    private readonly retryPolicy: RetryPolicyConfig,
    private readonly onAttemptFailure?: (info: AttemptFailureInfo) => void,
    private readonly modelAliases: Record<string, string> = {},
    private readonly modelBlacklist: string[] = [],
    private readonly availability?: ProviderAvailability,
  ) {}

  private resolveRequestedModel(modelId: string): string {
    const resolved = resolveModelAlias(modelId, this.modelAliases);
    if (
      isModelBlacklisted(modelId, this.modelBlacklist) ||
      isModelBlacklisted(resolved, this.modelBlacklist)
    ) {
      throw new GatewayError(`模型 ${modelId} 已被黑名单拦截`, {
        status: 400,
        type: 'invalid_request_error',
        code: 'model_blocked',
      });
    }
    return resolved;
  }

  private buildCandidates(
    modelId: string,
    requires?: CapabilityRequirement,
    estimatedTokens?: number,
  ): Candidate[] {
    const allEntries: ModelEntry[] = this.registry.candidates(modelId);
    const enabledEntries = allEntries.filter((entry) => entry.provider.enabled);
    if (enabledEntries.length === 0) {
      if (allEntries.length > 0) {
        throw new GatewayError(`模型 ${modelId} 的渠道均已禁用`, {
          status: 503,
          type: 'no_available_channel',
          code: 'model_unavailable',
        });
      }
      throw new GatewayError(`未知模型: ${modelId}`, {
        status: 404,
        type: 'invalid_request_error',
        code: 'model_not_found',
      });
    }

    const entries = this.availability
      ? enabledEntries.filter(
          (entry) => !this.availability?.isExhausted(entry.provider.id),
        )
      : enabledEntries;
    if (entries.length === 0) {
      const retryAfter = enabledEntries
        .map((entry) => this.availability?.retryAfterSeconds(entry.provider.id))
        .filter((value): value is number => typeof value === 'number');
      throw new GatewayError(`模型 ${modelId} 的渠道额度均已耗尽`, {
        status: 429,
        type: 'rate_limit_error',
        code: 'quota_exhausted',
        retryAfterSeconds:
          retryAfter.length > 0 ? Math.min(...retryAfter) : undefined,
      });
    }

    const capable =
      requires && (requires.tools || requires.vision || requires.reasoning)
        ? entries.filter((entry) => satisfiesCapabilities(entry.model, requires))
        : entries;
    if (capable.length === 0) {
      throw new GatewayError(
        `模型 ${modelId} 没有支持所需能力（${describeRequirements(requires ?? {})}）的渠道`,
        {
          status: 400,
          type: 'invalid_request_error',
          code: 'capability_mismatch',
        },
      );
    }

    const contextCapable =
      estimatedTokens !== undefined && estimatedTokens > 0
        ? capable.filter(
            (entry) =>
              !entry.model.contextWindow || estimatedTokens <= entry.model.contextWindow,
          )
        : capable;
    if (contextCapable.length === 0) {
      const smallest = capable
        .map((entry) => entry.model.contextWindow)
        .filter((window): window is number => typeof window === 'number')
        .sort((a, b) => a - b)[0];
      // 消息里带英文标准措辞：DSH 等客户端按文案识别上下文溢出（isContextWindowExceededError），
      // 识别后自动压缩历史并重试；纯中文文案不会被识别。
      throw new GatewayError(
        `Request is too large for this model's context window: estimated ${estimatedTokens} tokens, ` +
          `model ${modelId} context window ${smallest ?? 'unknown'}. ` +
          `请求约 ${estimatedTokens} tokens，超出模型 ${modelId} 的上下文窗口${smallest ? `（最小 ${smallest}）` : ''}`,
        {
          status: 400,
          type: 'invalid_request_error',
          code: 'context_window_exceeded',
        },
      );
    }

    const candidates: Candidate[] = [];
    let earliest: number | null = null;
    for (const entry of contextCapable) {
      const keys = entry.provider.keys.attemptOrder();
      if (keys.length === 0) {
        const cooldown = entry.provider.keys.earliestCooldown();
        if (cooldown !== null && (earliest === null || cooldown < earliest)) {
          earliest = cooldown;
        }
        continue;
      }
      for (const key of keys) {
        candidates.push({ provider: entry.provider, model: entry.model, key });
      }
    }

    if (candidates.length === 0) {
      throw new GatewayError(`模型 ${modelId} 当前无可用渠道`, {
        status: 503,
        type: 'no_available_channel',
        code: 'channels_cooling',
        retryAfterMs:
          earliest !== null ? Math.max(0, earliest - Date.now()) : undefined,
        retryAfterSeconds:
          earliest !== null
            ? Math.max(1, Math.ceil((earliest - Date.now()) / 1000))
            : undefined,
      });
    }
    return candidates.slice(0, this.maxAttempts);
  }

  private toGatewayError(
    error: UpstreamError,
    candidate: Candidate,
    attempts: number,
  ): GatewayError {
    const status = statusFor(error);
    const keyPart =
      candidate.key.label === 'no-auth' ? '' : ` / ${candidate.key.label}`;
    return new GatewayError(`${error.message}（渠道 ${candidate.provider.id}${keyPart}）`, {
      status,
      type: typeFor(status),
      code: error.category,
      retryAfterSeconds:
        error.retryAfterMs !== undefined
          ? Math.max(1, Math.ceil(error.retryAfterMs / 1000))
          : undefined,
      providerId: candidate.provider.id,
      keyLabel: candidate.key.label,
      attempts,
    });
  }

  private handleFailure(
    candidate: Candidate,
    error: unknown,
    signal: AbortSignal,
    attempts: number,
  ): UpstreamError {
    if (
      isAbortError(error) ||
      signal.aborted ||
      (error instanceof UpstreamError && error.category === 'cancelled')
    ) {
      throw new ClientAbortError();
    }
    const upErr =
      error instanceof UpstreamError
        ? error
        : new UpstreamError((error as Error)?.message ?? 'unknown upstream error', {
            category: 'server',
          });
    candidate.provider.keys.markFailure(
      candidate.key,
      upErr.category,
      this.cooldowns,
      upErr.retryAfterMs,
    );
    log.warn(
      `上游失败 ${candidate.provider.id}/${candidate.key.label} [${upErr.category}]: ${upErr.message}`,
    );
    try {
      this.onAttemptFailure?.({
        providerId: candidate.provider.id,
        keyLabel: candidate.key.label,
        category: upErr.category,
        status: upErr.status,
        message: upErr.message,
      });
    } catch (error) {
      log.error(`记录上游失败尝试出错: ${(error as Error).message}`);
    }
    if (!upErr.retryable) {
      throw this.toGatewayError(upErr, candidate, attempts);
    }
    return upErr;
  }

  private exhausted(
    last: { candidate: Candidate; error: UpstreamError } | null,
    attempts: number,
  ): GatewayError {
    if (!last) {
      return new GatewayError('没有可用的上游尝试', { status: 502, attempts });
    }
    const status = statusFor(last.error);
    return new GatewayError(
      `所有渠道均失败（尝试 ${attempts} 次）: ${last.error.message}`,
      {
        status,
        type: typeFor(status),
        code: last.error.category,
        retryAfterSeconds:
          last.error.retryAfterMs !== undefined
            ? Math.max(1, Math.ceil(last.error.retryAfterMs / 1000))
            : undefined,
        providerId: last.candidate.provider.id,
        keyLabel: last.candidate.key.label,
        attempts,
      },
    );
  }

  private maxTotalAttempts(): number {
    return (
      this.maxAttempts +
      (this.retryPolicy.enabled ? this.retryPolicy.maxRetries : 0)
    );
  }

  private remainingWait(waitedMs: number): number {
    return Math.max(0, this.retryPolicy.maxTotalWaitMs - waitedMs);
  }

  private canRetryFailure(
    error: UpstreamError,
    retries: number,
    attempts: number,
    waitedMs: number,
  ): boolean {
    const policy = this.retryPolicy;
    if (!policy.enabled) return false;
    if (retries >= policy.maxRetries) return false;
    if (!policy.retryOn.includes(error.category as RetryCategory)) return false;
    if (attempts >= this.maxTotalAttempts()) return false;
    return waitedMs < policy.maxTotalWaitMs;
  }

  private failureDelay(
    error: UpstreamError,
    candidates: Candidate[],
    retries: number,
    waitedMs: number,
  ): number | null {
    const policy = this.retryPolicy;
    let providerDelay =
      policy.respectRetryAfter &&
      error.retryAfterMs !== undefined &&
      error.retryAfterMs > 0
        ? error.retryAfterMs
        : 0;
    if (error.category === 'rate_limit') {
      const now = Date.now();
      const cooldowns = candidates
        .map((candidate) => candidate.provider.keys.earliestCooldown(now))
        .filter((value): value is number => typeof value === 'number')
        .map((until) => until - now);
      if (cooldowns.length > 0) {
        providerDelay = Math.max(providerDelay, Math.min(...cooldowns));
      }
    }
    const delay = Math.max(jitteredBackoff(policy, retries + 1), providerDelay);
    if (delay > this.remainingWait(waitedMs)) return null;
    return Math.max(1, Math.round(delay));
  }

  private coolingDelay(
    error: GatewayError,
    retries: number,
    waitedMs: number,
  ): number | null {
    const policy = this.retryPolicy;
    if (!policy.enabled || retries >= policy.maxRetries) return null;
    const coolingMs =
      error.retryAfterMs ??
      (error.retryAfterSeconds !== undefined
        ? error.retryAfterSeconds * 1000
        : undefined);
    if (coolingMs === undefined) return null;
    const delay = Math.max(
      jitteredBackoff(policy, retries + 1),
      coolingMs + 100,
    );
    if (delay > this.remainingWait(waitedMs)) return null;
    return Math.max(1, Math.round(delay));
  }

  private retryLog(modelId: string, delay: number, retries: number, waitedMs: number, reason: string): void {
    const limit = this.retryPolicy.maxRetries;
    log.warn(
      `模型 ${modelId} ${reason}，${delay}ms 后重试（第 ${retries + 1}/${limit} 次，已等待 ${waitedMs}ms）`,
    );
  }

  private async runAttempts<T>(
    modelId: string,
    requires: CapabilityRequirement | undefined,
    estimatedTokens: number,
    signal: AbortSignal,
    attempt: (candidate: Candidate, attempts: number) => Promise<T>,
  ): Promise<{ result: T; attempts: number }> {
    let last: { candidate: Candidate; error: UpstreamError } | null = null;
    let attempts = 0;
    let retries = 0;
    let waitedMs = 0;

    for (;;) {
      let candidates: Candidate[];
      try {
        candidates = this.buildCandidates(modelId, requires, estimatedTokens);
      } catch (error) {
        if (error instanceof GatewayError && error.code === 'channels_cooling') {
          const delay = this.coolingDelay(error, retries, waitedMs);
          if (delay !== null) {
            this.retryLog(modelId, delay, retries, waitedMs, '渠道冷却中');
            await sleep(delay, signal);
            retries += 1;
            waitedMs += delay;
            continue;
          }
          throw coolingExhausted(error, attempts, retries, waitedMs);
        }
        throw error;
      }

      for (const candidate of candidates) {
        if (signal.aborted) throw new ClientAbortError();
        if (attempts >= this.maxTotalAttempts()) {
          throw this.exhausted(last, attempts);
        }
        attempts += 1;
        candidate.provider.keys.markAttempt(candidate.key);
        try {
          const result = await attempt(candidate, attempts);
          candidate.provider.keys.markSuccess(candidate.key);
          return { result, attempts };
        } catch (error) {
          last = {
            candidate,
            error: this.handleFailure(candidate, error, signal, attempts),
          };
        }
      }

      if (!last) {
        throw new GatewayError('没有可用的上游尝试', { status: 502, attempts });
      }
      if (!this.canRetryFailure(last.error, retries, attempts, waitedMs)) {
        throw this.exhausted(last, attempts);
      }
      const delay = this.failureDelay(last.error, candidates, retries, waitedMs);
      if (delay === null) {
        throw this.exhausted(last, attempts);
      }
      this.retryLog(
        modelId,
        delay,
        retries,
        waitedMs,
        `上游 ${last.error.category}`,
      );
      await sleep(delay, signal);
      retries += 1;
      waitedMs += delay;
    }
  }

  async complete(
    request: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<NonStreamOutcome> {
    const modelId = this.resolveRequestedModel(request.model);
    const estimatedTokens =
      estimateRequestTokens(request) + (request.maxTokens ?? 0);
    const { result } = await this.runAttempts(
      modelId,
      request.requires,
      estimatedTokens,
      signal,
      async (candidate, attempts) => {
        const started = performance.now();
        const response = await candidate.provider.adapter.chat(
          request,
          candidate.model,
          { key: candidate.key.key, signal },
        );
        return {
          response,
          providerId: candidate.provider.id,
          keyLabel: candidate.key.label,
          upstreamModel: candidate.model.upstream,
          pricing: candidate.model.pricing,
          attempts,
          latencyMs: Math.round(performance.now() - started),
        };
      },
    );
    return result;
  }

  async openStream(
    request: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<StreamOutcome> {
    const modelId = this.resolveRequestedModel(request.model);
    const estimatedTokens =
      estimateRequestTokens(request) + (request.maxTokens ?? 0);
    const { result } = await this.runAttempts(
      modelId,
      request.requires,
      estimatedTokens,
      signal,
      async (candidate, attempts) => {
        const started = performance.now();
        let iterator: AsyncGenerator<StreamEvent, void, void> | null = null;
        try {
          iterator = candidate.provider.adapter.chatStream(request, candidate.model, {
            key: candidate.key.key,
            signal,
          });
          const firstResult = await iterator.next();
          if (firstResult.done) {
            throw new UpstreamError('上游在首包前结束', {
              category: 'empty_stream',
              retryable: true,
            });
          }
          const first = firstResult.value;
          const ttfbMs = Math.round(performance.now() - started);
          const committed = iterator;
          const events = (async function* () {
            yield first;
            yield* committed;
          })();
          return {
            first,
            events,
            providerId: candidate.provider.id,
            keyLabel: candidate.key.label,
            upstreamModel: candidate.model.upstream,
            pricing: candidate.model.pricing,
            attempts,
            ttfbMs,
          };
        } catch (error) {
          if (iterator) {
            try {
              await iterator.return(undefined);
            } catch {
              // ignore cleanup errors
            }
          }
          throw error;
        }
      },
    );
    return result;
  }
}
