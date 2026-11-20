import {
  estimateRequestTokens,
  roughTokenEstimate,
  textOf,
  type CanonicalRequest,
  type CanonicalResponse,
  type StreamEvent,
} from '../canonical.js';
import type { ModelConfig } from '../config.js';
import type { ChatContext, ProviderAdapter } from './types.js';

function lastUserText(request: CanonicalRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message && message.role === 'user') {
      const text = textOf(message.parts);
      if (text) return text;
    }
  }
  return '';
}

function echoText(request: CanonicalRequest, model: ModelConfig): string {
  const input = lastUserText(request);
  return `[mock:${model.id}] ${input || '(empty prompt)'}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class MockAdapter implements ProviderAdapter {
  async chat(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
  ): Promise<CanonicalResponse> {
    await sleep(30, ctx.signal);
    const text = echoText(request, model);
    return {
      id: `chatcmpl-mock-${Date.now().toString(36)}`,
      model: model.id,
      text,
      toolCalls: [],
      stopReason: 'stop',
      usage: {
        inputTokens: estimateRequestTokens(request),
        outputTokens: roughTokenEstimate(text),
        estimated: true,
      },
    };
  }

  async *chatStream(
    request: CanonicalRequest,
    model: ModelConfig,
    ctx: ChatContext,
  ): AsyncGenerator<StreamEvent, void, void> {
    await sleep(30, ctx.signal);
    const text = echoText(request, model);
    const step = Math.max(6, Math.ceil(text.length / 6));
    for (let i = 0; i < text.length; i += step) {
      await sleep(20, ctx.signal);
      yield { type: 'text_delta', text: text.slice(i, i + step) };
    }
    const usage = {
      inputTokens: estimateRequestTokens(request),
      outputTokens: roughTokenEstimate(text),
      estimated: true,
    };
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: 'stop' };
  }
}
