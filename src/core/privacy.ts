import { createHmac } from 'node:crypto';
import type {
  CanonicalRequest,
  CanonicalResponse,
  ContentPart,
  StreamEvent,
} from '../canonical.js';
import { textOf } from '../canonical.js';
import type { PrivacyConfig, ResolvedConfig } from '../config.js';
import { log } from '../logger.js';
import type { Store } from '../store/db.js';
import { maskKey } from './keys.js';
import { encryptSecret, isSecretEncryptionAvailable, tryDecryptSecret } from './secrets.js';

/**
 * 隐私守卫（Privacy Guard）。
 *
 * 模型永远看不到敏感明文：出站请求里的密钥 / 口令 / 身份值被替换成稳定占位符
 * ⟦p:<类别>:<8位哈希>⟧，真值经 AES-256-GCM / DPAPI 加密后只存本地 SQLite 保管库；
 * 上游返回（含流式 delta 与工具参数）里的占位符在网关还原成真值再交给客户端，
 * 对 agent 完全透明。占位符对同一真值稳定（HMAC），不打散上游 prompt cache。
 *
 * 边界：防的是显式敏感值进入上游，防不了模型从上下文推断；桥接渠道
 * （opencode/zcode/qoder）的内部工具循环不在网关视野内，默认不启用（见 appliesTo）。
 */

export type PrivacyCategory =
  | 'config_secret'
  | 'api_key'
  | 'jwt'
  | 'assignment'
  | 'private_key'
  | 'connection'
  | 'bearer'
  | 'identity_path'
  | 'email'
  | 'uid';

export interface PrivacyFinding {
  category: PrivacyCategory;
  value: string;
  start: number;
  end: number;
}

const PLACEHOLDER_PREFIX = '⟦p:';
const PLACEHOLDER_RE = /⟦p:([a-z_]+):([0-9a-f]{8})⟧/g;
/** 占位符最长形态：⟦p:config_secret:xxxxxxxx⟧ = 24 字符。流式缓冲按它判定。 */
const PLACEHOLDER_MAX_LEN = 24;
/** 超过该长度的文本不做检测（图片 base64 / 超大粘贴），避免正则回溯开销。 */
const MAX_SCAN_LENGTH = 512 * 1024;
const MIN_CONFIG_SECRET_LENGTH = 8;

interface PatternRule {
  category: PrivacyCategory;
  re: RegExp;
  /** 命中里真正要令牌化的捕获组（如赋值语句只换值，不换键名）。 */
  group?: number;
  /** 命中整体最短长度，过滤噪声。 */
  minLength?: number;
}

const CREDENTIAL_RULES: PatternRule[] = [
  {
    category: 'private_key',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  {
    category: 'api_key',
    re: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{30,}|dop_v1_[a-f0-9]{40,}|QODER(?:CN)?_[A-Za-z0-9_-]{16,})\b/g,
  },
  {
    category: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    category: 'connection',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]+@[^\s'"]+/gi,
    minLength: 12,
  },
  {
    category: 'assignment',
    re: /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|pwd|token)\b(["']?\s*[:=]\s*)(["'])([^"'\r\n]{6,512})\2/gi,
    group: 3,
  },
  {
    category: 'assignment',
    re: /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|pwd|token)\b(["']?\s*[:=]\s*)([^\s"',;{}\[\]]{8,512})/gi,
    group: 2,
  },
  {
    category: 'bearer',
    re: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/g,
    group: 1,
  },
];

const IDENTITY_RULES: PatternRule[] = [
  {
    category: 'identity_path',
    re: /[A-Za-z]:\\Users\\[^\\/:*?"<>|\s]+|\/(?:home|Users)\/[A-Za-z0-9._-]+/g,
    minLength: 10,
  },
  {
    category: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    category: 'uid',
    re: /\b(?:uid|user[_-]?id|username|user[_-]?name|account)\b(["']?\s*[:=]\s*)(["'])([^"'\r\n]{2,128})\2/gi,
    group: 3,
  },
  {
    category: 'uid',
    re: /\b(?:uid|user[_-]?id)\b(["']?\s*[:=]\s*)(\d{3,20})\b/gi,
    group: 2,
  },
];

export interface ConfigSecret {
  value: string;
  category: PrivacyCategory;
}

/** 收集网关自身配置里的密钥 / 口令，用于零误报的精确匹配。 */
export function collectConfigSecrets(config: ResolvedConfig): ConfigSecret[] {
  const values = new Map<string, PrivacyCategory>();
  const add = (value: string | null | undefined) => {
    if (value && value.length >= MIN_CONFIG_SECRET_LENGTH) {
      values.set(value, 'config_secret');
    }
  };
  add(config.admin.token);
  for (const key of config.server.clientKeys) add(key);
  for (const provider of config.providers) {
    if (provider.type === 'openai-compatible') {
      for (const key of provider.keys) add(key.key);
      for (const header of Object.values(provider.quota?.headers ?? {})) add(header);
    }
  }
  return [...values.entries()].map(([value, category]) => ({ value, category }));
}

function overlaps(a: PrivacyFinding, b: PrivacyFinding): boolean {
  return a.start < b.end && b.start < a.end;
}

/** 扫描一段文本里的敏感值；重叠命中保留先出现（规则顺序即优先级）的那个。 */
export function detectSecrets(
  text: string,
  options: { identity: boolean; configSecrets: ConfigSecret[] },
): PrivacyFinding[] {
  if (!text || text.length > MAX_SCAN_LENGTH) return [];
  const findings: PrivacyFinding[] = [];
  const push = (finding: PrivacyFinding) => {
    if (finding.value.length === 0) return;
    if (findings.some((existing) => overlaps(existing, finding))) return;
    findings.push(finding);
  };

  for (const secret of options.configSecrets) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(secret.value, from);
      if (index < 0) break;
      push({
        category: secret.category,
        value: secret.value,
        start: index,
        end: index + secret.value.length,
      });
      from = index + secret.value.length;
    }
  }

  const rules = options.identity
    ? [...CREDENTIAL_RULES, ...IDENTITY_RULES]
    : CREDENTIAL_RULES;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.re.exec(text)) !== null) {
      const whole = match[0];
      if (rule.minLength && whole.length < rule.minLength) continue;
      if (rule.group === undefined) {
        push({
          category: rule.category,
          value: whole,
          start: match.index,
          end: match.index + whole.length,
        });
      } else {
        const value = match[rule.group];
        if (!value) continue;
        const offset = whole.lastIndexOf(value);
        if (offset < 0) continue;
        push({
          category: rule.category,
          value,
          start: match.index + offset,
          end: match.index + offset + value.length,
        });
      }
      if (match.index === rule.re.lastIndex) rule.re.lastIndex += 1;
    }
  }
  findings.sort((a, b) => a.start - b.start);
  return findings;
}

interface PreparedRequest {
  request: CanonicalRequest;
  /** 本次请求命中的敏感值（去重），audit 模式也记录。 */
  findings: Array<{ category: PrivacyCategory; value: string }>;
  /** token 模式下实际写入的占位符数量。 */
  replaced: number;
}

export interface PrivacyGuardOptions {
  store: Store;
  /** 每次请求时读取最新配置（热加载）。 */
  getConfig: () => ResolvedConfig;
  /** 保管库加密密钥（进程生命周期内稳定）。 */
  hmacKey: Buffer;
}

export class PrivacyGuard {
  private readonly store: Store;
  private readonly getConfig: () => ResolvedConfig;
  private readonly hmacKey: Buffer;
  private configSecrets: ConfigSecret[] = [];
  private secretsFingerprint = '';
  /** token 模式且加密可用才真正替换；否则降级 audit。 */
  private degraded = false;

  constructor(options: PrivacyGuardOptions) {
    this.store = options.store;
    this.getConfig = options.getConfig;
    this.hmacKey = options.hmacKey;
    this.refreshSecrets();
    this.evaluateDegradation();
  }

  /** 配置热加载后刷新精确匹配集合。 */
  refreshSecrets(): void {
    const config = this.getConfig();
    const secrets = config.privacy.protectConfigSecrets
      ? collectConfigSecrets(config)
      : [];
    const fingerprint = secrets.map((s) => s.value).join('\u0000');
    if (fingerprint !== this.secretsFingerprint) {
      this.configSecrets = secrets;
      this.secretsFingerprint = fingerprint;
    }
    this.evaluateDegradation();
  }

  private evaluateDegradation(): void {
    const config = this.getConfig();
    const wantToken = config.privacy.mode === 'token';
    const available = isSecretEncryptionAvailable();
    if (wantToken && !available && !this.degraded) {
      log.warn('隐私守卫：当前环境不支持密钥加密，token 模式降级为 audit（只检测不替换）');
    }
    this.degraded = wantToken && !available;
  }

  private effectiveMode(config: PrivacyConfig): 'off' | 'audit' | 'token' {
    if (config.mode === 'off') return 'off';
    if (config.mode === 'token' && !this.degraded) return 'token';
    return 'audit';
  }

  appliesTo(providerId: string, providerType: string): boolean {
    const config = this.getConfig().privacy;
    if (this.effectiveMode(config) === 'off') return false;
    // 桥接渠道内部还有自己的工具循环，网关只能管外层文本，默认不启用。
    const bridge = providerType !== 'openai-compatible' && providerType !== 'mock';
    if (bridge && !config.providers.include.includes(providerId)) return false;
    if (config.providers.exclude.includes(providerId)) return false;
    if (
      config.providers.include.length > 0 &&
      !config.providers.include.includes(providerId)
    ) {
      return false;
    }
    return true;
  }

  private placeholderFor(value: string, category: PrivacyCategory): string {
    const hash = createHmac('sha256', this.hmacKey)
      .update(category)
      .update('\u0000')
      .update(value)
      .digest('hex')
      .slice(0, 8);
    return PLACEHOLDER_PREFIX + category + ':' + hash + '⟧';
  }

  private remember(value: string, category: PrivacyCategory, placeholder: string): void {
    const config = this.getConfig().privacy;
    const enc = encryptSecret(value);
    this.store.upsertPrivacyVault({
      placeholder,
      category,
      valueEnc: enc,
      masked: maskKey(value),
      now: Date.now(),
    });
    this.store.prunePrivacyVault({
      maxEntries: config.maxVaultEntries,
      olderThanMs: Date.now() - config.tokenRetentionDays * 86400000,
    });
  }

  private scanOptions() {
    const config = this.getConfig().privacy;
    return { identity: config.identity, configSecrets: this.configSecrets };
  }

  /** 出站：扫描并（token 模式）替换请求里的敏感值。返回新请求，不改原对象。 */
  prepareRequest(request: CanonicalRequest, providerId: string, providerType: string): PreparedRequest {
    const noop: PreparedRequest = { request, findings: [], replaced: 0 };
    if (!this.appliesTo(providerId, providerType)) return noop;
    // appliesTo 已排除 off；这里只剩 audit / token。
    const mode: 'audit' | 'token' =
      this.effectiveMode(this.getConfig().privacy) === 'token' ? 'token' : 'audit';
    const options = this.scanOptions();
    const findings = new Map<string, PrivacyCategory>();
    let replaced = 0;

    const transform = (text: string): string => {
      const hits = detectSecrets(text, options);
      if (hits.length === 0) return text;
      let output = '';
      let cursor = 0;
      for (const hit of hits) {
        if (!findings.has(hit.value)) findings.set(hit.value, hit.category);
        if (mode === 'token') {
          const placeholder = this.placeholderFor(hit.value, hit.category);
          this.remember(hit.value, hit.category, placeholder);
          output += text.slice(cursor, hit.start) + placeholder;
          cursor = hit.end;
          replaced += 1;
        }
      }
      if (mode !== 'token') return text;
      return output + text.slice(cursor);
    };

    const transformPart = (part: ContentPart): ContentPart => {
      if (part.type === 'text') {
        return { ...part, text: transform(part.text) };
      }
      if (part.type === 'thinking') {
        return { ...part, text: transform(part.text) };
      }
      if (part.type === 'tool_call') {
        return { ...part, argumentsJson: transform(part.argumentsJson) };
      }
      if (part.type === 'tool_result') {
        return {
          ...part,
          content: part.content.map((item) => ({ ...item, text: transform(item.text) })),
        };
      }
      return part;
    };

    const messages = request.messages.map((message) => ({
      ...message,
      parts: message.parts.map(transformPart),
    }));
    const tools = request.tools?.map((tool) => ({
      ...tool,
      description: tool.description ? transform(tool.description) : tool.description,
      inputSchema: transformJsonStrings(tool.inputSchema, transform),
    }));
    const stop = request.stop?.map(transform);

    const prepared: CanonicalRequest = { ...request, messages };
    if (tools) prepared.tools = tools;
    if (stop) prepared.stop = stop;

    const findingList = [...findings.entries()].map(([value, category]) => ({ category, value }));
    if (findingList.length > 0) {
      this.audit({
        providerId,
        direction: 'outbound',
        sessionId: request.sessionId ?? null,
        model: request.model,
        findings: findingList,
        replaced: mode === 'token' ? replaced : 0,
        mode,
      });
    }
    return { request: prepared, findings: findingList, replaced };
  }

  /** 入站（非流式）：把响应里的占位符还原成真值。 */
  restoreResponse(response: CanonicalResponse, providerId: string): CanonicalResponse {
    if (!this.appliesTo(providerId, this.providerTypeOf(providerId))) return response;
    let restored = 0;
    const restore = (text: string): string => {
      const result = this.restoreText(text);
      restored += result.count;
      return result.text;
    };
    const next: CanonicalResponse = {
      ...response,
      text: restore(response.text),
      toolCalls: response.toolCalls.map((call) => ({
        ...call,
        argumentsJson: restore(call.argumentsJson),
      })),
    };
    if (response.thinking !== undefined) next.thinking = restore(response.thinking);
    if (restored > 0) {
      this.audit({
        providerId,
        direction: 'inbound',
        sessionId: null,
        model: response.model,
        findings: [],
        replaced: restored,
        mode: 'token',
        restoredOnly: restored,
      });
    }
    return next;
  }

  private providerTypeOf(providerId: string): string {
    // restoreResponse 只有直连渠道会走到；类型从配置里查，查不到按直连处理。
    const provider = this.getConfig().providers.find((p) => p.id === providerId);
    return provider?.type ?? 'openai-compatible';
  }

  /** 把文本里的占位符替换回真值；未知占位符原样保留。 */
  restoreText(text: string): { text: string; count: number } {
    if (!text || !text.includes(PLACEHOLDER_PREFIX)) return { text, count: 0 };
    let count = 0;
    const output = text.replace(PLACEHOLDER_RE, (whole, _category: string, hash: string) => {
      const placeholder = whole;
      const row = this.store.getPrivacyVault(placeholder);
      if (!row) return whole;
      const decrypted = tryDecryptSecret(row.valueEnc);
      if (decrypted.value === undefined) {
        log.warn('隐私守卫：保管库条目解密失败，占位符原样保留（主密钥可能已更换）');
        return whole;
      }
      void hash;
      count += 1;
      return decrypted.value;
    });
    return { text: output, count };
  }

  /** 入站（流式）：逐事件还原；文本 delta 跨帧缓冲，工具参数按 index 聚合后整体还原。 */
  restoreEvents(
    events: AsyncGenerator<StreamEvent, void, void>,
    providerId: string,
  ): AsyncGenerator<StreamEvent, void, void> {
    const guard = this;
    const providerType = this.providerTypeOf(providerId);
    return (async function* () {
      if (!guard.appliesTo(providerId, providerType)) {
        yield* events;
        return;
      }
      // 文本 / 思考各自一条缓冲；工具参数按 index 聚合。
      let textBuffer = '';
      let thinkingBuffer = '';
      const toolBuffers = new Map<
        number,
        { id?: string; name?: string; args: string; emittedId: boolean; emittedName: boolean }
      >();
      let restoredTotal = 0;

      const flushText = (final: boolean): StreamEvent[] => {
        const out: StreamEvent[] = [];
        let buffer = textBuffer;
        if (!final) {
          // 尾部可能是半个占位符：留住最长可能前缀，其余放行。
          const hold = partialPlaceholderSuffix(buffer);
          if (hold > 0) {
            const emitPart = buffer.slice(0, buffer.length - hold);
            textBuffer = buffer.slice(buffer.length - hold);
            if (emitPart) {
              const r = guard.restoreText(emitPart);
              restoredTotal += r.count;
              out.push({ type: 'text_delta', text: r.text });
            }
            return out;
          }
        }
        textBuffer = '';
        if (buffer) {
          const r = guard.restoreText(buffer);
          restoredTotal += r.count;
          out.push({ type: 'text_delta', text: r.text });
        }
        return out;
      };

      const flushThinking = (final: boolean): StreamEvent[] => {
        const out: StreamEvent[] = [];
        let buffer = thinkingBuffer;
        if (!final) {
          const hold = partialPlaceholderSuffix(buffer);
          if (hold > 0) {
            const emitPart = buffer.slice(0, buffer.length - hold);
            thinkingBuffer = buffer.slice(buffer.length - hold);
            if (emitPart) {
              const r = guard.restoreText(emitPart);
              restoredTotal += r.count;
              out.push({ type: 'thinking_delta', text: r.text });
            }
            return out;
          }
        }
        thinkingBuffer = '';
        if (buffer) {
          const r = guard.restoreText(buffer);
          restoredTotal += r.count;
          out.push({ type: 'thinking_delta', text: r.text });
        }
        return out;
      };

      const flushTools = (final: boolean, onlyIndex?: number): StreamEvent[] => {
        const out: StreamEvent[] = [];
        for (const [index, state] of toolBuffers) {
          if (onlyIndex !== undefined && index !== onlyIndex) continue;
          // id / name 一到就发（可能分帧到达）；参数聚合到 finish 再整体还原发出。
          const pending: { id?: string; name?: string } = {};
          if (state.id && !state.emittedId) {
            pending.id = state.id;
            state.emittedId = true;
          }
          if (state.name && !state.emittedName) {
            pending.name = state.name;
            state.emittedName = true;
          }
          if (pending.id || pending.name) {
            out.push({ type: 'tool_call_delta', index, ...pending });
          }
          if (final && state.args) {
            const r = guard.restoreText(state.args);
            restoredTotal += r.count;
            out.push({ type: 'tool_call_delta', index, argumentsDelta: r.text });
            state.args = '';
          }
        }
        return out;
      };

      try {
        for await (const event of events) {
          if (event.type === 'text_delta') {
            textBuffer += event.text;
            yield* flushText(false);
          } else if (event.type === 'thinking_delta') {
            thinkingBuffer += event.text;
            yield* flushThinking(false);
          } else if (event.type === 'tool_call_delta') {
            let state = toolBuffers.get(event.index);
            if (!state) {
              state = { args: '', emittedId: false, emittedName: false };
              toolBuffers.set(event.index, state);
            }
            if (event.id) state.id = event.id;
            if (event.name) state.name = event.name;
            if (event.argumentsDelta) state.args += event.argumentsDelta;
            yield* flushTools(false, event.index);
          } else if (event.type === 'finish') {
            yield* flushText(true);
            yield* flushThinking(true);
            yield* flushTools(true);
            if (restoredTotal > 0) {
              guard.audit({
                providerId,
                direction: 'inbound',
                sessionId: null,
                model: null,
                findings: [],
                replaced: restoredTotal,
                mode: 'token',
                restoredOnly: restoredTotal,
              });
            }
            yield event;
          } else {
            // usage / keepalive 原样透传；先把缓冲里攒着的文本放出去，保持顺序。
            yield* flushText(false);
            yield* flushThinking(false);
            yield event;
          }
        }
        // 上游没发 finish 就结束：兜底清空缓冲。
        yield* flushText(true);
        yield* flushThinking(true);
        yield* flushTools(true);
      } finally {
        // 客户端中断时也要把上游迭代器关掉。
        await events.return(undefined).catch(() => {});
      }
    })();
  }

  private audit(info: {
    providerId: string;
    direction: 'outbound' | 'inbound';
    sessionId: string | null;
    model: string | null;
    findings: Array<{ category: PrivacyCategory; value: string }>;
    replaced: number;
    mode: 'audit' | 'token';
    restoredOnly?: number;
  }): void {
    try {
      if (info.restoredOnly !== undefined) {
        this.store.recordPrivacyEvent({
          ts: Date.now(),
          provider: info.providerId,
          direction: info.direction,
          category: 'restore',
          action: 'restored',
          count: info.restoredOnly,
          masked: null,
          sessionId: info.sessionId,
          model: info.model,
        });
        return;
      }
      const byCategory = new Map<PrivacyCategory, { count: number; masked: string }>();
      for (const finding of info.findings) {
        const entry = byCategory.get(finding.category) ?? {
          count: 0,
          masked: maskKey(finding.value),
        };
        entry.count += 1;
        byCategory.set(finding.category, entry);
      }
      for (const [category, entry] of byCategory) {
        this.store.recordPrivacyEvent({
          ts: Date.now(),
          provider: info.providerId,
          direction: info.direction,
          category,
          action: info.mode === 'token' ? 'tokenized' : 'detected',
          count: entry.count,
          masked: entry.masked,
          sessionId: info.sessionId,
          model: info.model,
        });
      }
      if (info.mode === 'audit' && info.findings.length > 0) {
        log.info(
          '隐私守卫[audit] ' + info.providerId + ' 出站命中 ' + info.findings.length + ' 处敏感值（未替换）',
        );
      }
    } catch (error) {
      log.warn('隐私守卫：审计落库失败 ' + (error as Error).message);
    }
  }

  snapshot(): {
    mode: 'off' | 'audit' | 'token';
    degraded: boolean;
    configSecrets: number;
    vaultEntries: number;
  } {
    const config = this.getConfig().privacy;
    return {
      mode: this.effectiveMode(config),
      degraded: this.degraded,
      configSecrets: this.configSecrets.length,
      vaultEntries: this.store.countPrivacyVault(),
    };
  }
}

/** 递归替换 JSON 结构里的字符串值（工具 schema 的 default / examples 等）。 */
function transformJsonStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((item) => transformJsonStrings(item, transform));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = transformJsonStrings(item, transform);
    }
    return out;
  }
  return value;
}

/** 文本尾部是否可能是占位符的前缀；返回需要缓冲的字符数。 */
function partialPlaceholderSuffix(buffer: string): number {
  const max = Math.min(buffer.length, PLACEHOLDER_MAX_LEN - 1);
  for (let len = max; len >= 1; len -= 1) {
    const suffix = buffer.slice(buffer.length - len);
    if (isPlaceholderPrefix(suffix)) return len;
  }
  return 0;
}

const PLACEHOLDER_BODY_RE = /^[a-z_]*$/;
const PLACEHOLDER_HASH_RE = /^[0-9a-f]*$/;

function isPlaceholderPrefix(candidate: string): boolean {
  if (candidate.length === 0) return false;
  if (PLACEHOLDER_PREFIX.startsWith(candidate)) return true;
  if (!candidate.startsWith(PLACEHOLDER_PREFIX)) return false;
  const rest = candidate.slice(PLACEHOLDER_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return PLACEHOLDER_BODY_RE.test(rest);
  const category = rest.slice(0, colon);
  if (!PLACEHOLDER_BODY_RE.test(category) || category.length === 0) return false;
  const after = rest.slice(colon + 1);
  const close = after.indexOf('⟧');
  if (close >= 0) return false; // 完整占位符不算“半个”
  return after.length <= 8 && PLACEHOLDER_HASH_RE.test(after);
}
