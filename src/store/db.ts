import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type RequestStatus = 'ok' | 'error' | 'cancelled';

export interface RequestRecord {
  requestId: string;
  ts: number;
  endpoint: string;
  stream: boolean;
  requestedModel: string;
  provider?: string | null;
  upstreamModel?: string | null;
  keyLabel?: string | null;
  status: RequestStatus;
  httpStatus?: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimated: boolean;
  costUsd?: number | null;
  latencyMs?: number | null;
  ttfbMs?: number | null;
  sessionId?: string | null;
  error?: string | null;
  attempts: number;
}

export interface Totals {
  requests: number;
  ok: number;
  errors: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  avgLatencyMs: number | null;
  avgTtfbMs: number | null;
}

export interface ProviderKeyStats {
  provider: string;
  keyLabel: string | null;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AttemptFailureRecord {
  ts: number;
  provider: string;
  keyLabel: string | null;
  category: string;
  status?: number | null;
  message?: string | null;
}

export interface AttemptFailureStats {
  provider: string;
  keyLabel: string | null;
  failures: number;
}

export interface OcSessionRow {
  gatewaySessionId: string;
  providerId: string;
  ocSessionId: string;
  modelPublic: string;
  modelUpstream: string;
  oneShot: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OcLedgerRow {
  msgId: string;
  role: string;
  text: string;
  delivered: boolean;
  createdAt: number;
}

export interface OcQuestionRow {
  id: string;
  gatewaySessionId: string;
  providerId: string;
  ocSessionId: string;
  kind: 'form' | 'permission';
  requestId: string;
  payload: unknown;
  status: string;
  createdAt: number;
  answeredAt: number | null;
  answer: unknown;
}

export interface RecentRequest {
  id: number;
  requestId: string;
  ts: number;
  endpoint: string;
  stream: boolean;
  requestedModel: string;
  provider: string | null;
  upstreamModel: string | null;
  keyLabel: string | null;
  status: RequestStatus;
  httpStatus: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimated: boolean;
  costUsd: number | null;
  latencyMs: number | null;
  ttfbMs: number | null;
  sessionId: string | null;
  error: string | null;
  attempts: number;
}

export interface RecentRequestQuery {
  limit?: number;
  offset?: number;
  provider?: string;
  status?: string;
  model?: string;
  sinceMs?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  requested_model TEXT NOT NULL,
  provider TEXT,
  upstream_model TEXT,
  key_label TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  latency_ms INTEGER,
  ttfb_ms INTEGER,
  session_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_provider_ts ON requests(provider, ts);
CREATE TABLE IF NOT EXISTS attempt_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  key_label TEXT,
  category TEXT NOT NULL,
  status INTEGER,
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempt_failures_ts ON attempt_failures(ts);
CREATE TABLE IF NOT EXISTS oc_sessions (
  gateway_session_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  oc_session_id TEXT NOT NULL,
  model_public TEXT NOT NULL,
  model_upstream TEXT NOT NULL,
  one_shot INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (gateway_session_id, provider_id)
);
CREATE TABLE IF NOT EXISTS oc_ledger (
  gateway_session_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (gateway_session_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_oc_ledger_delivered ON oc_ledger(gateway_session_id, delivered);
CREATE TABLE IF NOT EXISTS oc_tasks (
  id TEXT PRIMARY KEY,
  gateway_session_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  oc_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  usage_json TEXT
);
CREATE TABLE IF NOT EXISTS oc_questions (
  id TEXT PRIMARY KEY,
  gateway_session_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  oc_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  answer TEXT
);
CREATE INDEX IF NOT EXISTS idx_oc_questions_status ON oc_questions(status);
CREATE TABLE IF NOT EXISTS response_store (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  output_json TEXT
);
`;

const INSERT_SQL = `
INSERT INTO requests (
  request_id, ts, endpoint, stream, requested_model, provider, upstream_model,
  key_label, status, http_status, input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_write_tokens, estimated, cost_usd, latency_ms,
  ttfb_ms, session_id, error, attempts
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function safeJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly insertFailureStmt: StatementSync;
  private readonly totalsStmt: StatementSync;
  private readonly providerStatsStmt: StatementSync;
  private readonly attemptFailureStatsStmt: StatementSync;

  constructor(path: string) {
    const isMemory = path === ':memory:';
    if (!isMemory) {
      const absolute = resolve(path);
      mkdirSync(dirname(absolute), { recursive: true });
      this.db = new DatabaseSync(absolute);
    } else {
      this.db = new DatabaseSync(':memory:');
    }
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);

    this.insertStmt = this.db.prepare(INSERT_SQL);
    this.insertFailureStmt = this.db.prepare(`
      INSERT INTO attempt_failures (ts, provider, key_label, category, status, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.totalsStmt = this.db.prepare(`
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS ok,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        AVG(CASE WHEN status = 'ok' THEN latency_ms END) AS avg_latency_ms,
        AVG(CASE WHEN status = 'ok' THEN ttfb_ms END) AS avg_ttfb_ms
      FROM requests
      WHERE ts >= ?
    `);
    this.providerStatsStmt = this.db.prepare(`
      SELECT
        provider,
        key_label,
        COUNT(*) AS requests,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM requests
      WHERE ts >= ? AND provider IS NOT NULL
      GROUP BY provider, key_label
    `);
    this.attemptFailureStatsStmt = this.db.prepare(`
      SELECT provider, key_label, COUNT(*) AS failures
      FROM attempt_failures
      WHERE ts >= ?
      GROUP BY provider, key_label
    `);
  }

  recordRequest(record: RequestRecord): void {
    this.insertStmt.run(
      record.requestId,
      record.ts,
      record.endpoint,
      record.stream ? 1 : 0,
      record.requestedModel,
      record.provider ?? null,
      record.upstreamModel ?? null,
      record.keyLabel ?? null,
      record.status,
      record.httpStatus ?? null,
      record.inputTokens,
      record.outputTokens,
      record.reasoningTokens,
      record.cacheReadTokens,
      record.cacheWriteTokens,
      record.estimated ? 1 : 0,
      record.costUsd ?? null,
      record.latencyMs ?? null,
      record.ttfbMs ?? null,
      record.sessionId ?? null,
      record.error ? record.error.slice(0, 500) : null,
      record.attempts,
    );
  }

  totals(sinceMs: number): Totals {
    const row = this.totalsStmt.get(sinceMs) as Record<string, unknown> | undefined;
    return {
      requests: num(row?.requests),
      ok: num(row?.ok),
      errors: num(row?.errors),
      cancelled: num(row?.cancelled),
      inputTokens: num(row?.input_tokens),
      outputTokens: num(row?.output_tokens),
      reasoningTokens: num(row?.reasoning_tokens),
      costUsd: num(row?.cost_usd),
      avgLatencyMs: nullableNum(row?.avg_latency_ms),
      avgTtfbMs: nullableNum(row?.avg_ttfb_ms),
    };
  }

  providerKeyStats(sinceMs: number): ProviderKeyStats[] {
    const rows = this.providerStatsStmt.all(sinceMs) as Record<string, unknown>[];
    return rows.map((row) => ({
      provider: String(row.provider),
      keyLabel: nullableStr(row.key_label),
      requests: num(row.requests),
      errors: num(row.errors),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      costUsd: num(row.cost_usd),
    }));
  }

  recordAttemptFailure(record: AttemptFailureRecord): void {
    this.insertFailureStmt.run(
      record.ts,
      record.provider,
      record.keyLabel ?? null,
      record.category,
      record.status ?? null,
      record.message ? record.message.slice(0, 300) : null,
    );
  }

  attemptFailureStats(sinceMs: number): AttemptFailureStats[] {
    const rows = this.attemptFailureStatsStmt.all(sinceMs) as Record<string, unknown>[];
    return rows.map((row) => ({
      provider: String(row.provider),
      keyLabel: nullableStr(row.key_label),
      failures: num(row.failures),
    }));
  }

  upsertOcSession(row: OcSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO oc_sessions
          (gateway_session_id, provider_id, oc_session_id, model_public, model_upstream, one_shot, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(gateway_session_id, provider_id) DO UPDATE SET
           oc_session_id = excluded.oc_session_id,
           model_public = excluded.model_public,
           model_upstream = excluded.model_upstream,
           one_shot = excluded.one_shot,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.gatewaySessionId,
        row.providerId,
        row.ocSessionId,
        row.modelPublic,
        row.modelUpstream,
        row.oneShot ? 1 : 0,
        row.createdAt,
        row.updatedAt,
      );
  }

  getOcSession(gatewaySessionId: string, providerId: string): OcSessionRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM oc_sessions WHERE gateway_session_id = ? AND provider_id = ?`,
      )
      .get(gatewaySessionId, providerId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      gatewaySessionId: String(row.gateway_session_id),
      providerId: String(row.provider_id),
      ocSessionId: String(row.oc_session_id),
      modelPublic: String(row.model_public),
      modelUpstream: String(row.model_upstream),
      oneShot: num(row.one_shot) === 1,
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
    };
  }

  deleteOcSession(gatewaySessionId: string, providerId: string): void {
    this.db
      .prepare(`DELETE FROM oc_sessions WHERE gateway_session_id = ? AND provider_id = ?`)
      .run(gatewaySessionId, providerId);
  }

  insertLedgerMessages(
    gatewaySessionId: string,
    items: Array<{ msgId: string; role: string; text: string }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO oc_ledger
        (gateway_session_id, msg_id, role, text, delivered, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    );
    const now = Date.now();
    for (const item of items) {
      stmt.run(gatewaySessionId, item.msgId, item.role, item.text, now);
    }
  }

  getUndeliveredLedger(gatewaySessionId: string): OcLedgerRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM oc_ledger WHERE gateway_session_id = ? AND delivered = 0 AND role IN ('user', 'system')
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(gatewaySessionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      msgId: String(row.msg_id),
      role: String(row.role),
      text: String(row.text),
      delivered: false,
      createdAt: num(row.created_at),
    }));
  }

  getLastUserLedger(gatewaySessionId: string): OcLedgerRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM oc_ledger WHERE gateway_session_id = ? AND role = 'user'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(gatewaySessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      msgId: String(row.msg_id),
      role: String(row.role),
      text: String(row.text),
      delivered: num(row.delivered) === 1,
      createdAt: num(row.created_at),
    };
  }

  markAllLedgerDelivered(gatewaySessionId: string): void {
    this.db
      .prepare(
        `UPDATE oc_ledger SET delivered = 1 WHERE gateway_session_id = ? AND delivered = 0`,
      )
      .run(gatewaySessionId);
  }

  resetLedgerDelivered(gatewaySessionId: string): void {
    this.db
      .prepare(`UPDATE oc_ledger SET delivered = 0 WHERE gateway_session_id = ?`)
      .run(gatewaySessionId);
  }

  appendAssistantLedger(gatewaySessionId: string, text: string): void {
    if (!text) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO oc_ledger
          (gateway_session_id, msg_id, role, text, delivered, created_at)
         VALUES (?, ?, 'assistant', ?, 1, ?)`,
      )
      .run(
        gatewaySessionId,
        `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text,
        Date.now(),
      );
  }

  recordOcTask(row: {
    id: string;
    gatewaySessionId: string;
    providerId: string;
    ocSessionId: string;
    state: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oc_tasks
          (id, gateway_session_id, provider_id, oc_session_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.gatewaySessionId,
        row.providerId,
        row.ocSessionId,
        row.state,
        row.createdAt,
        row.createdAt,
      );
  }

  updateOcTask(
    id: string,
    state: string,
    error?: string | null,
    usage?: unknown,
  ): void {
    const finished = state === 'finished' || state === 'failed' || state === 'interrupted';
    this.db
      .prepare(
        `UPDATE oc_tasks SET state = ?, updated_at = ?, finished_at = COALESCE(?, finished_at),
           error = ?, usage_json = ? WHERE id = ?`,
      )
      .run(
        state,
        Date.now(),
        finished ? Date.now() : null,
        error ?? null,
        usage === undefined ? null : JSON.stringify(usage),
        id,
      );
  }

  markStaleOcState(): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE oc_tasks SET state = 'interrupted', updated_at = ?, finished_at = ?
         WHERE state IN ('running', 'suspended')`,
      )
      .run(now, now);
    this.db
      .prepare(`UPDATE oc_questions SET status = 'expired' WHERE status = 'pending'`)
      .run();
  }

  createOcQuestion(row: {
    id: string;
    gatewaySessionId: string;
    providerId: string;
    ocSessionId: string;
    kind: 'form' | 'permission';
    requestId: string;
    payload: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oc_questions
          (id, gateway_session_id, provider_id, oc_session_id, kind, request_id, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        row.id,
        row.gatewaySessionId,
        row.providerId,
        row.ocSessionId,
        row.kind,
        row.requestId,
        JSON.stringify(row.payload),
        Date.now(),
      );
  }

  resolveOcQuestion(id: string, status: 'answered' | 'expired', answer?: unknown): void {
    this.db
      .prepare(
        `UPDATE oc_questions SET status = ?, answered_at = ?, answer = ? WHERE id = ?`,
      )
      .run(status, Date.now(), answer === undefined ? null : JSON.stringify(answer), id);
  }

  listPendingOcQuestions(): OcQuestionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM oc_questions WHERE status = 'pending' ORDER BY created_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      gatewaySessionId: String(row.gateway_session_id),
      providerId: String(row.provider_id),
      ocSessionId: String(row.oc_session_id),
      kind: String(row.kind) as 'form' | 'permission',
      requestId: String(row.request_id),
      payload: safeJson(row.payload),
      status: String(row.status),
      createdAt: num(row.created_at),
      answeredAt: nullableNum(row.answered_at),
      answer: safeJson(row.answer),
    }));
  }

  saveResponseRecord(row: {
    id: string;
    createdAt: number;
    model: string;
    messagesJson: string;
    outputJson?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO response_store (id, created_at, model, messages_json, output_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           created_at = excluded.created_at,
           model = excluded.model,
           messages_json = excluded.messages_json,
           output_json = excluded.output_json`,
      )
      .run(row.id, row.createdAt, row.model, row.messagesJson, row.outputJson ?? null);
  }

  getResponseRecord(id: string): {
    id: string;
    createdAt: number;
    model: string;
    messagesJson: string;
    outputJson: string | null;
  } | null {
    const row = this.db
      .prepare(`SELECT * FROM response_store WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      createdAt: num(row.created_at),
      model: String(row.model),
      messagesJson: String(row.messages_json),
      outputJson: nullableStr(row.output_json),
    };
  }

  backupTo(path: string): void {
    const escaped = path.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  recentRequests(query: RecentRequestQuery = {}): RecentRequest[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (query.sinceMs !== undefined) {
      conditions.push('ts >= ?');
      params.push(query.sinceMs);
    }
    if (query.provider) {
      conditions.push('provider = ?');
      params.push(query.provider);
    }
    if (query.status) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    if (query.model) {
      conditions.push('requested_model = ?');
      params.push(query.model);
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM requests ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: num(row.id),
      requestId: String(row.request_id),
      ts: num(row.ts),
      endpoint: String(row.endpoint),
      stream: num(row.stream) === 1,
      requestedModel: String(row.requested_model),
      provider: nullableStr(row.provider),
      upstreamModel: nullableStr(row.upstream_model),
      keyLabel: nullableStr(row.key_label),
      status: String(row.status) as RequestStatus,
      httpStatus: nullableNum(row.http_status),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      reasoningTokens: num(row.reasoning_tokens),
      estimated: num(row.estimated) === 1,
      costUsd: nullableNum(row.cost_usd),
      latencyMs: nullableNum(row.latency_ms),
      ttfbMs: nullableNum(row.ttfb_ms),
      sessionId: nullableStr(row.session_id),
      error: nullableStr(row.error),
      attempts: num(row.attempts),
    }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore double-close
    }
  }
}
