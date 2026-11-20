import type {
  CanonicalRequest,
  CanonicalResponse,
  CapabilityRequirement,
  StreamEvent,
} from '../canonical.js';
import { estimateRequestTokens } from '../canonical.js';
import type { CooldownConfig, ModelConfig, ModelPricing } from '../config.js';
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
      throw new GatewayError(
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
        providerId: last.candidate.provider.id,
        keyLabel: last.candidate.key.label,
        attempts,
      },
    );
  }

  async complete(
    request: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<NonStreamOutcome> {
    const modelId = this.resolveRequestedModel(request.model);
    const estimatedTokens =
      estimateRequestTokens(request) + (request.maxTokens ?? 0);
    const candidates = this.buildCandidates(modelId, request.requires, estimatedTokens);
    let last: { candidate: Candidate; error: UpstreamError } | null = null;
    let attempts = 0;

    for (const candidate of candidates) {
      if (signal.aborted) throw new ClientAbortError();
      attempts += 1;
      candidate.provider.keys.markAttempt(candidate.key);
      const started = performance.now();
      try {
        const response = await candidate.provider.adapter.chat(
          request,
          candidate.model,
          { key: candidate.key.key, signal },
        );
        candidate.provider.keys.markSuccess(candidate.key);
        return {
          response,
          providerId: candidate.provider.id,
          keyLabel: candidate.key.label,
          upstreamModel: candidate.model.upstream,
          pricing: candidate.model.pricing,
          attempts,
          latencyMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        last = {
          candidate,
          error: this.handleFailure(candidate, error, signal, attempts),
        };
      }
    }
    throw this.exhausted(last, attempts);
  }

  async openStream(
    request: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<StreamOutcome> {
    const modelId = this.resolveRequestedModel(request.model);
    const estimatedTokens =
      estimateRequestTokens(request) + (request.maxTokens ?? 0);
    const candidates = this.buildCandidates(modelId, request.requires, estimatedTokens);
    let last: { candidate: Candidate; error: UpstreamError } | null = null;
    let attempts = 0;

    for (const candidate of candidates) {
      if (signal.aborted) throw new ClientAbortError();
      attempts += 1;
      candidate.provider.keys.markAttempt(candidate.key);
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
        candidate.provider.keys.markSuccess(candidate.key);
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
        last = {
          candidate,
          error: this.handleFailure(candidate, error, signal, attempts),
        };
      }
    }
    throw this.exhausted(last, attempts);
  }
}
