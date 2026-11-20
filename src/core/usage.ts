import {
  estimateRequestTokens,
  type CanonicalRequest,
  type StreamEvent,
  type Usage,
} from '../canonical.js';
import type { ModelPricing } from '../config.js';

function charsToTokens(chars: number): number {
  return chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0;
}

export class UsageCollector {
  private usage: Usage | null = null;
  private outputChars = 0;
  private thinkingChars = 0;

  observe(event: StreamEvent): void {
    if (event.type === 'usage') {
      if (event.usage.inputTokens > 0 || event.usage.outputTokens > 0 || this.usage === null) {
        this.usage = event.usage;
      }
    } else if (event.type === 'text_delta') {
      this.outputChars += event.text.length;
    } else if (event.type === 'thinking_delta') {
      this.thinkingChars += event.text.length;
    } else if (event.type === 'tool_call_delta') {
      this.outputChars += event.argumentsDelta?.length ?? 0;
    }
  }

  finalize(request: CanonicalRequest): Usage {
    if (this.usage && (this.usage.inputTokens > 0 || this.usage.outputTokens > 0)) {
      return this.usage;
    }
    return {
      inputTokens: estimateRequestTokens(request),
      outputTokens: charsToTokens(this.outputChars),
      reasoningTokens:
        this.thinkingChars > 0 ? charsToTokens(this.thinkingChars) : undefined,
      estimated: true,
    };
  }
}

export function computeCost(
  usage: Usage,
  pricing: ModelPricing | undefined,
): number | null {
  if (!pricing) return null;
  const inputPrice = pricing.inputPerMtok;
  const outputPrice = pricing.outputPerMtok;
  if (inputPrice === undefined && outputPrice === undefined) return null;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const billableInput = Math.max(0, usage.inputTokens - cacheRead);
  const inPrice = inputPrice ?? 0;
  const outPrice = outputPrice ?? 0;
  const cacheReadPrice = pricing.cacheReadPerMtok ?? inPrice;
  const cacheWritePrice = pricing.cacheWritePerMtok ?? inPrice;

  const cost =
    (billableInput * inPrice +
      cacheRead * cacheReadPrice +
      cacheWrite * cacheWritePrice +
      usage.outputTokens * outPrice) /
    1_000_000;
  return Number(cost.toFixed(6));
}
