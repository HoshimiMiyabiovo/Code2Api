import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

type Mode = 'normal' | 'question' | 'permission';

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeOpenCode {
  private readonly server: Server;
  readonly password = 'fake-opencode-pass';
  baseUrl = '';
  mode: Mode = 'normal';
  /** kilo = KiloDesktop 内置 CLI 实测行为：无 /api/info、模型条目无 type、DELETE session 404。 */
  flavor: 'opencode' | 'kilo' = 'opencode';
  /** 追加到原版 /api/model 的额外条目（如订阅渠道 fake-go 的付费模型），默认空。 */
  goModels: Array<Record<string, unknown>> = [];
  /** finishTask 模拟的内部 step 用量序列；缺省单 step 保持老行为。 */
  stepPlan?: Array<{
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  }> = undefined;
  readonly prompts: Array<{ sessionID: string; text: string }> = [];
  readonly decisions: string[] = [];
  /** kilo v2 permission reply 的原始形状（路径参数 + body），用于断言网关发的是 v2 契约。 */
  readonly permissionReplies: Array<{
    sessionID: string;
    permissionID: string;
    response: string;
  }> = [];
  readonly answers: unknown[] = [];
  readonly createdLocations: Array<string | undefined> = [];
  readonly modelSelections: any[] = [];
  private readonly sessions = new Map<string, any>();
  private readonly clients = new Set<ServerResponse>();
  private counter = 0;
  private lastText = '';
  private lastReply = '';
  private assistantId = 'msg_fake_assistant';
  private questionSession = '';
  /** mode='permission' 时记录最近一次挂起审批的会话 ID（测试断言用）。 */
  permissionSession = '';
  /** kilo v2 question reply 记录（requestID + answers），断言网关发的是 v2 契约。 */
  readonly questionReplies: Array<{ requestID: string; answers: unknown }> = [];
  /** kilo v2 question reject 记录。 */
  readonly questionRejections: string[] = [];

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const client of [...this.clients]) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({
      id: `evt_${++this.counter}`,
      created: Date.now(),
      type,
      data,
    })}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const expected =
      'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64');
    return req.headers.authorization === expected;
  }

  private createSession(title: string, model: any, directory?: string): any {
    const id = `ses_fake_${++this.counter}`;
    const session = {
      id,
      projectID: 'fake-project',
      title,
      model: model ?? { id: 'fake-model', providerID: 'fake' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), updated: Date.now() },
      location: { directory: directory ?? 'C:/fake' },
    };
    this.sessions.set(id, session);
    return session;
  }

  private finishTask(sessionID: string, assistantMessageID: string, text: string): void {
    this.lastReply = text;
    this.emit('session.text.started', {
      sessionID,
      assistantMessageID,
      ordinal: 0,
    });
    this.emit('session.text.delta', {
      sessionID,
      assistantMessageID,
      ordinal: 0,
      delta: text,
    });
    this.emit('session.text.ended', {
      sessionID,
      assistantMessageID,
      ordinal: 0,
      text,
    });
    // 默认单 step（老行为不变）；stepPlan 可模拟桥接任务的内部多 step agent 循环。
    const steps = this.stepPlan ?? [
      { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 0 },
    ];
    for (const step of steps) {
      this.emit('session.step.ended', {
        sessionID,
        assistantMessageID,
        finish: 'stop',
        rawFinish: 'stop',
        tokens: {
          input: step.input,
          output: step.output,
          reasoning: step.reasoning,
          cache: { read: step.cacheRead, write: step.cacheWrite },
        },
        cost: 0,
      });
    }
    this.emit('session.usage.updated', {
      sessionID,
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
    });
    this.emit('session.execution.succeeded', { sessionID });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (
      !url.pathname.startsWith('/api/') &&
      !url.pathname.startsWith('/session/') &&
      url.pathname !== '/config'
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'auth required' } }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/info') {
      if (this.flavor === 'kilo') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 'fake', pid: process.pid }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ $schema: 'https://app.kilo.ai/config.json', permission: {} }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/model') {
      const autoModel: Record<string, unknown> = {
        id: 'auto-model',
        modelID: 'auto-model',
        providerID: 'fake',
        type: 'chat',
        enabled: true,
        status: 'active',
        capabilities: { tools: true, input: ['text', 'image'] },
        limit: { context: 100000, output: 8192 },
        cost: [{ input: 1, output: 2, cache: { read: 0.5, write: 0 } }],
        variants: [
          { id: 'low', settings: { reasoningEffort: 'low' } },
          { id: 'medium', settings: { reasoningEffort: 'medium' } },
          { id: 'high', settings: { reasoningEffort: 'high' } },
        ],
      };
      const imageModel: Record<string, unknown> = {
        id: 'fake-image',
        modelID: 'fake-image',
        providerID: 'fake',
        type: 'image',
        enabled: true,
        status: 'active',
      };
      const freeModel: Record<string, unknown> = {
        id: 'vendor/free-chat:free',
        modelID: 'vendor/free-chat:free',
        providerID: 'fake',
        enabled: true,
        status: 'active',
        capabilities: { tools: true, input: ['text'] },
        limit: { context: 200000, output: 16384 },
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      };
      if (this.flavor === 'kilo') {
        // kilo 实测（v7.8.27）：全部条目无 type 字段；id 可含斜杠；disabled 条目仍在目录里。
        delete autoModel.type;
        delete imageModel.type;
        autoModel.id = 'vendor/auto-model';
        autoModel.modelID = 'vendor/auto-model';
        imageModel.id = 'vendor/fake-image';
        imageModel.modelID = 'vendor/fake-image';
        imageModel.enabled = false;
        imageModel.status = 'disabled';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [autoModel, imageModel, freeModel] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [autoModel, imageModel, ...this.goModels] }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/event') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      this.clients.add(res);
      this.emit('server.connected', {});
      req.on('close', () => this.clients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      const body = await readJson(req);
      this.createdLocations.push(body.location?.directory);
      this.modelSelections.push(body.model);
      const session = this.createSession(
        body.title ?? 'fake',
        body.model,
        body.location?.directory,
      );
      if (this.flavor === 'kilo' && session.model) {
        // kilo 实测：会话回显 variant；未指定时服务端填 "default"（非思考）。
        session.model = { ...session.model, variant: body.model?.variant ?? 'default' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: session }));
      return;
    }

    // kilo v2 question reply/reject：POST /question/{requestID}/reply（body { answers: string[][] }）
    // 与 POST /question/{requestID}/reject（KiloClient SDK 契约，模型提问工具）。
    const v2QuestionReply = /^\/question\/([^/]+)\/(reply|reject)$/.exec(url.pathname);
    if (v2QuestionReply && this.flavor === 'kilo' && req.method === 'POST') {
      const requestID = decodeURIComponent(v2QuestionReply[1] ?? '');
      const action = v2QuestionReply[2] ?? 'reply';
      const sessionID = this.questionSession;
      if (action === 'reject') {
        this.questionRejections.push(requestID);
        this.emit('question.rejected', { sessionID, requestID });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        this.finishTask(sessionID, 'msg_after_question', 'question rejected');
        return;
      }
      const body = await readJson(req);
      const answers = body.answers;
      if (
        !Array.isArray(answers) ||
        answers.length === 0 ||
        !answers.every((item: unknown) => Array.isArray(item))
      ) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            _tag: 'InvalidRequestError',
            message: 'Missing key\n at ["answers"]',
            kind: 'Payload',
          }),
        );
        return;
      }
      this.questionReplies.push({ requestID, answers });
      this.emit('question.replied', { sessionID, requestID, answers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      this.finishTask(sessionID, 'msg_after_question', 'fake reply after question');
      return;
    }

    const v2PermissionReply = /^\/session\/([^/]+)\/permissions\/([^/]+)$/.exec(
      url.pathname,
    );
    if (v2PermissionReply && this.flavor === 'kilo' && req.method === 'POST') {
      const sessionID = decodeURIComponent(v2PermissionReply[1] ?? '');
      const permissionID = decodeURIComponent(v2PermissionReply[2] ?? '');
      const body = await readJson(req);
      if (
        body.response !== 'once' &&
        body.response !== 'always' &&
        body.response !== 'reject'
      ) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            _tag: 'InvalidRequestError',
            message: 'Missing key\n at ["response"]',
            kind: 'Payload',
          }),
        );
        return;
      }
      this.decisions.push(body.response);
      this.permissionReplies.push({
        sessionID,
        permissionID,
        response: body.response,
      });
      this.emit('permission.replied', {
        sessionID,
        requestID: permissionID,
        reply: body.response,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      this.finishTask(sessionID, 'msg_after_permission', 'permission handled');
      return;
    }

    // kilo fork：v2 /session/:id/message 才真正调度 agent loop（v1 /prompt 只入队）。
    // 事件流用 message.part.updated（part 累积全文）+ message.updated + session.idle。
    const v2Message = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (v2Message && this.flavor === 'kilo' && req.method === 'POST') {
      const sessionID = decodeURIComponent(v2Message[1] ?? '');
      const body = await readJson(req);
      const textPart = Array.isArray(body.parts)
        ? body.parts.find((p: any) => p?.type === 'text')
        : null;
      if (typeof textPart?.text !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            _tag: 'InvalidRequestError',
            message: 'Missing key at ["parts"]',
            kind: 'Payload',
          }),
        );
        return;
      }
      const text = textPart.text;
      this.lastText = text;
      this.prompts.push({ sessionID, text });
      const assistantMessageID = `msg_asst_${++this.counter}`;
      this.assistantId = assistantMessageID;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          info: { id: assistantMessageID, sessionID, role: 'user' },
        }),
      );
      const reply = `fake reply: ${text}`;
      const partID = `prt_${this.counter}`;
      const userMessageID = `msg_user_${this.counter}`;
      setTimeout(() => {
        if (this.mode === 'permission') {
          // kilo v2 路径同样支持审批挂起场景。
          this.permissionSession = sessionID;
          this.emit('permission.asked', {
            id: 'per_fake_1',
            sessionID,
            permission: 'bash',
            patterns: ['git status --short'],
            metadata: { command: 'git status --short' },
          });
          return;
        }
        // 先推 user 消息的角色登记与 part 全文——回归断言：网关绝不能把 user part 当模型输出透传。
        this.emit('message.updated', {
          sessionID,
          info: { id: userMessageID, sessionID, role: 'user' },
        });
        this.emit('message.part.updated', {
          sessionID,
          part: {
            id: `prt_user_${this.counter}`,
            sessionID,
            messageID: userMessageID,
            type: 'text',
            text,
          },
        });
        // assistant：先角色登记，再累积全文两次推送（模拟流式增长）；
        // 中间夹一条 synthetic 占位符验证网关会忽略。
        this.emit('message.updated', {
          sessionID,
          info: {
            id: assistantMessageID,
            sessionID,
            role: 'assistant',
            tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 1, write: 0 } },
          },
        });
        this.emit('message.part.updated', {
          sessionID,
          part: {
            id: partID,
            sessionID,
            messageID: assistantMessageID,
            type: 'text',
            text: reply.slice(0, 5),
          },
        });
        this.emit('message.part.updated', {
          sessionID,
          part: {
            id: `prt_spin_${this.counter}`,
            sessionID,
            messageID: assistantMessageID,
            type: 'text',
            text: '⠋ working…',
            synthetic: true,
          },
        });
        this.emit('message.part.updated', {
          sessionID,
          part: {
            id: partID,
            sessionID,
            messageID: assistantMessageID,
            type: 'text',
            text: reply,
          },
        });
        this.emit('session.idle', { sessionID });
      }, 20);
      return;
    }

    const sessionMatch = /^\/api\/session\/([^/]+)(.*)$/.exec(url.pathname);
    if (sessionMatch) {
      const sessionID = decodeURIComponent(sessionMatch[1] ?? '');
      const rest = sessionMatch[2] ?? '';
      const session = this.sessions.get(sessionID);
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'session not found' } }));
        return;
      }

      if (req.method === 'GET' && rest === '') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: session }));
        return;
      }
      if (req.method === 'POST' && rest === '/model') {
        const body = await readJson(req);
        this.modelSelections.push(body.model);
        session.model = body.model;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: session }));
        return;
      }
      if (req.method === 'DELETE' && rest === '') {
        if (this.flavor === 'kilo') {
          // kilo 实测：DELETE /api/session/:id 返回 404（路由已变），网关必须容错。
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'not found' } }));
          return;
        }
        this.sessions.delete(sessionID);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (req.method === 'GET' && rest === '/message') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'msg_fake_user',
                type: 'user',
                text: this.lastText,
                time: { created: Date.now() - 1000 },
              },
              ...(this.lastReply
                ? [
                    {
                      id: this.assistantId,
                      type: 'assistant',
                      time: { created: Date.now() },
                      content: [{ type: 'text', text: this.lastReply }],
                      finish: 'stop',
                      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
                    },
                  ]
                : []),
            ],
            cursor: {},
          }),
        );
        return;
      }
      if (req.method === 'POST' && rest === '/prompt') {
        const body = await readJson(req);
        // 原版 opencode 请求体是 { text, delivery }；kilo fork 是 { prompt: { text } }
        // （v7.8.27 实测：PromptInput 为对象、必填 text；纯字符串报 Expected PromptInput）。
        // fake 按各自风味严格校验，防止网关回归。
        let text: string;
        if (this.flavor === 'kilo') {
          if (typeof body.prompt === 'string') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                _tag: 'InvalidRequestError',
                message: `Expected PromptInput, got ${JSON.stringify(body.prompt)}\n at ["prompt"]`,
                kind: 'Payload',
              }),
            );
            return;
          }
          if (typeof body.prompt?.text !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                _tag: 'InvalidRequestError',
                message: 'Missing key\n at ["prompt"]["text"]',
                kind: 'Payload',
              }),
            );
            return;
          }
          text = body.prompt.text;
        } else {
          if (typeof body.text !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ error: { message: 'Missing key at ["text"]' } }),
            );
            return;
          }
          text = body.text;
        }
        this.lastText = text;
        this.prompts.push({ sessionID, text });
        const assistantMessageID = `msg_asst_${++this.counter}`;
        this.assistantId = assistantMessageID;
        this.emit('session.inbox.enqueued', { sessionID, inboxID: `msg_${this.counter}` });
        this.emit('session.execution.started', { sessionID });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: {
              id: `msg_${this.counter}`,
              sessionID,
              type: 'user',
              payload: { text },
              delivery: 'steer',
              time: { created: Date.now() },
            },
          }),
        );
        setTimeout(() => {
          if (this.mode === 'question') {
            this.questionSession = sessionID;
            this.emit('form.created', {
              sessionID,
              form: {
                id: 'frm_fake_1',
                sessionID,
                title: '确认',
                fields: [
                  {
                    key: 'q0',
                    title: '是否继续',
                    type: 'string',
                    options: [{ value: '继续', label: '继续' }],
                    custom: true,
                  },
                ],
              },
            });
            return;
          }
          if (this.mode === 'permission') {
            this.permissionSession = sessionID;
            if (this.flavor === 'kilo') {
              // kilo 实测 payload：{id, sessionID, permission, patterns, metadata}，
              // 没有 action/resources 字段。
              this.emit('permission.asked', {
                id: 'per_fake_1',
                sessionID,
                permission: 'bash',
                patterns: ['git status --short'],
                metadata: { command: 'git status --short' },
              });
            } else {
              this.emit('permission.asked', {
                id: 'per_fake_1',
                sessionID,
                action: 'read',
                resources: ['*.env'],
              });
            }
            return;
          }
          this.emit('session.tool.called', {
            sessionID,
            assistantMessageID,
            id: 'tool_fake_1',
            name: 'shell',
            input: { command: 'echo fake' },
            executed: false,
          });
          this.emit('session.tool.success', {
            sessionID,
            assistantMessageID,
            id: 'tool_fake_1',
            content: [{ type: 'text', text: 'fake' }],
            executed: false,
          });
          this.finishTask(sessionID, assistantMessageID, `fake reply: ${text}`);
        }, 20);
        return;
      }
      // kilo fork：v1 question reply 路由不存在（v2 是顶层 /question/:requestID/reply）。
      if (
        this.flavor === 'kilo' &&
        req.method === 'POST' &&
        rest.startsWith('/question/') &&
        rest.endsWith('/reply')
      ) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      if (req.method === 'POST' && rest.startsWith('/form/') && rest.endsWith('/reply')) {
        const body = await readJson(req);
        this.answers.push(body.answer);
        this.emit('form.replied', {
          sessionID,
          id: 'frm_fake_1',
          answer: body.answer,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        this.finishTask(sessionID, 'msg_after_answer', 'fake reply after answer');
        return;
      }
      if (
        req.method === 'POST' &&
        rest.startsWith('/permission/') &&
        rest.endsWith('/reply')
      ) {
        if (this.flavor === 'kilo') {
          // kilo fork 没有 v1 permission reply 路由（真实 404），网关必须走 v2
          // /session/:id/permissions/:permissionID；此分支防回归。
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              _tag: 'NotFoundError',
              data: { message: 'Permission not found' },
            }),
          );
          return;
        }
        const body = await readJson(req);
        // 原版 opencode 的 permission reply body 键是 { decision }。
        const decision = body.decision;
        if (typeof decision !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              _tag: 'InvalidRequestError',
              message: 'Missing key\n at ["decision"]',
              kind: 'Payload',
            }),
          );
          return;
        }
        this.decisions.push(decision);
        this.emit('permission.replied', {
          sessionID,
          requestID: 'per_fake_1',
          reply: decision,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        this.finishTask(sessionID, 'msg_after_permission', 'permission handled');
        return;
      }
      if (req.method === 'POST' && rest === '/interrupt') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ interrupted: true }));
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  }
}

interface Harness {
  base: string;
  adminToken: string;
  gateway: Gateway;
  close: () => Promise<void>;
}

async function startGateway(yaml: string, password: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-oc-test-'));
  const dbPath = join(dir, 'gateway.db').replaceAll('\\', '/');
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, yaml.replaceAll('__DB__', dbPath), 'utf8');
  const config = loadConfig(configPath);
  process.env.C2A_TEST_OC_PASSWORD = password;
  const gateway = await createGateway(config, { configPath });
  await gateway.app.listen({ host: '127.0.0.1', port: 0 });
  const address = gateway.app.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    adminToken: gateway.ctx.adminToken,
    gateway,
    close: async () => {
      await gateway.shutdown();
      delete process.env.C2A_TEST_OC_PASSWORD;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function configYaml(
  fake: FakeOpenCode,
  permissionMode: 'ask' | 'allow',
  workspaceRoots: string[] = [],
  options: { questionTimeoutMs?: number } = {},
): string {
  const rootsYaml =
    workspaceRoots.length > 0
      ? `    workspace_roots:\n${workspaceRoots.map((root) => `      - ${JSON.stringify(root)}`).join('\n')}\n`
      : '';
  const questionTimeoutMs = options.questionTimeoutMs ?? 60000;
  return `
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-oc
    type: opencode
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    agent: build
    permission_mode: ${permissionMode}
${rootsYaml}    question_timeout_ms: ${questionTimeoutMs}
    task_timeout_ms: 120000
    models:
      - id: oc-test
        upstream: fake/fake-model
        context_window: 100000
        max_output_tokens: 8192
        capabilities:
          tools: true
          vision: false
          reasoning: true
`;
}

async function adminGet(harness: Harness, path: string): Promise<any> {
  const response = await fetch(`${harness.base}${path}`, {
    headers: { authorization: `Bearer ${harness.adminToken}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('opencode 任务级：非流式、流式与增量去重', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  const harness = await startGateway(configYaml(fake, 'allow'), fake.password);
  try {
    const first = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-session-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        messages: [{ role: 'user', content: 'hello-1' }],
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.choices[0].message.content, 'fake reply: hello-1');

    const second = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-session-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'user', content: 'hello-1' },
          { role: 'assistant', content: 'fake reply: hello-1' },
          { role: 'user', content: 'hello-2' },
        ],
      }),
    });
    assert.equal(second.status, 200);
    const sse = await second.text();
    assert.match(sse, /fake reply: hello-2/);
    assert.match(sse, /\[工具\] shell 调用/);
    assert.match(sse, /\[工具\] tool_fake_1 完成/);
    assert.match(sse, /data: \[DONE\]/);
    assert.match(sse, /"usage":\{"prompt_tokens":10,"completion_tokens":5/);
    assert.deepEqual(
      fake.prompts.map((p) => p.text),
      ['hello-1', 'hello-2'],
    );

    const requests = await adminGet(harness, '/admin/api/requests?range=all&limit=10');
    assert.equal(requests.requests[0].provider, 'fake-oc');
    assert.equal(requests.requests[0].inputTokens, 10);
    assert.equal(requests.requests[0].outputTokens, 5);
    assert.equal(requests.requests[0].estimated, false);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 提问挂起：面板回答后继续执行', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  fake.mode = 'question';
  // question_timeout_ms 24000 → 心跳间隔 = max(3000, timeout/8) = 3000ms，便于确定性断言。
  const harness = await startGateway(
    configYaml(fake, 'allow', [], { questionTimeoutMs: 24000 }),
    fake.password,
  );
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-question-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'please ask' }],
      }),
    });
    assert.equal(response.status, 200);
    const bodyPromise = response.text();

    let questions: any[] = [];
    for (let i = 0; i < 50; i += 1) {
      const data = await adminGet(harness, '/admin/api/questions');
      questions = data.questions;
      if (questions.length > 0) break;
      await sleep(100);
    }
    assert.equal(questions.length, 1);
    assert.equal(questions[0].kind, 'form');
    assert.equal(questions[0].payload.title, '确认');

    // 挂起期间网关持续发 SSE 心跳注释帧，客户端空闲超时不会掐断连接。
    await sleep(3400);

    const answer = await fetch(
      `${harness.base}/admin/api/questions/${questions[0].id}/answer`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ answer: { q0: '继续' } }),
      },
    );
    assert.equal(answer.status, 200);
    const sse = await bodyPromise;
    assert.match(sse, /: keepalive/);
    assert.match(sse, /需要你的确认/);
    assert.match(sse, /fake reply after answer/);
    assert.match(sse, /data: \[DONE\]/);
    assert.deepEqual(fake.answers, [{ q0: '继续' }]);
    const pending = await adminGet(harness, '/admin/api/questions');
    assert.equal(pending.questions.length, 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 审批自动允许', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  fake.mode = 'permission';
  const harness = await startGateway(configYaml(fake, 'allow'), fake.password);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-perm-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        messages: [{ role: 'user', content: 'need permission' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'permission handled');
    assert.deepEqual(fake.decisions, ['once']);
    const questions = await adminGet(harness, '/admin/api/questions');
    assert.equal(questions.questions.length, 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 审批挂起：面板应答走 v1 reply 路由后任务继续', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  fake.mode = 'permission';
  const harness = await startGateway(configYaml(fake, 'ask'), fake.password);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-perm-ask-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        stream: true,
        messages: [{ role: 'user', content: 'need permission' }],
      }),
    });
    assert.equal(response.status, 200);
    const bodyPromise = response.text();

    let questions: any[] = [];
    for (let i = 0; i < 50; i += 1) {
      const data = await adminGet(harness, '/admin/api/questions');
      questions = data.questions;
      if (questions.length > 0) break;
      await sleep(100);
    }
    assert.equal(questions.length, 1);
    assert.equal(questions[0].kind, 'permission');

    const answer = await fetch(
      `${harness.base}/admin/api/questions/${questions[0].id}/answer`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'once' }),
      },
    );
    assert.equal(answer.status, 200);
    const sse = await bodyPromise;
    assert.match(sse, /permission handled/);
    assert.deepEqual(fake.decisions, ['once']);
    // 原版必须走 v1 路由，v2 permissions 是 kilo 专属。
    assert.equal(fake.permissionReplies.length, 0);
    const pending = await adminGet(harness, '/admin/api/questions');
    assert.equal(pending.questions.length, 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('kilo 审批挂起：面板应答走 v2 permissions 路由后任务继续', async () => {
  const fake = new FakeOpenCode();
  fake.flavor = 'kilo';
  fake.mode = 'permission';
  await fake.start();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-kilo-perm
    type: opencode
    flavor: kilo
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    permission_mode: ask
    question_timeout_ms: 60000
    task_timeout_ms: 120000
    models:
      - id: oc-test
        upstream: fake/fake-model
        context_window: 100000
        max_output_tokens: 8192
        capabilities:
          tools: true
          vision: false
          reasoning: true
`, fake.password);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'kilo-perm-1',
      },
      body: JSON.stringify({
        model: 'oc-test',
        stream: true,
        messages: [{ role: 'user', content: 'need permission' }],
      }),
    });
    assert.equal(response.status, 200);
    const bodyPromise = response.text();

    let questions: any[] = [];
    for (let i = 0; i < 50; i += 1) {
      const data = await adminGet(harness, '/admin/api/questions');
      questions = data.questions;
      if (questions.length > 0) break;
      await sleep(100);
    }
    assert.equal(questions.length, 1);
    assert.equal(questions[0].kind, 'permission');

    const answer = await fetch(
      `${harness.base}/admin/api/questions/${questions[0].id}/answer`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'once' }),
      },
    );
    assert.equal(answer.status, 200);
    const sse = await bodyPromise;
    assert.match(sse, /permission handled/);
    assert.deepEqual(fake.decisions, ['once']);
    // kilo 必须走 v2 /session/:id/permissions/:permissionID（body { response }）。
    assert.deepEqual(fake.permissionReplies, [
      {
        sessionID: fake.permissionSession,
        permissionID: 'per_fake_1',
        response: 'once',
      },
    ]);
    const pending = await adminGet(harness, '/admin/api/questions');
    assert.equal(pending.questions.length, 0);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 自动发现模型：无需手填 models', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: auto-oc
    type: opencode
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    auto_models: true
    models: []
`, fake.password);
  try {
    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    const ids = models.data.map((m: any) => m.id);
    assert.ok(ids.includes('auto-model'));
    assert.ok(!ids.includes('fake-image'));

    const admin = await adminGet(harness, '/admin/api/models');
    const auto = admin.models.find((m: any) => m.id === 'auto-model');
    assert.ok(auto);
    assert.equal(auto.source, 'upstream');
    assert.equal(auto.contextWindow, 100000);
    assert.equal(auto.capabilities.vision, true);

    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'auto-model',
        messages: [{ role: 'user', content: 'auto' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'fake reply: auto');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 请求级工作区：白名单校验、创建与切换', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  const root = mkdtempSync(join(tmpdir(), 'c2a-ws-root-'));
  const wsA = join(root, 'proj-a');
  const wsB = join(root, 'proj-b');
  mkdirSync(wsA);
  mkdirSync(wsB);
  const outside = mkdtempSync(join(tmpdir(), 'c2a-ws-out-'));
  const harness = await startGateway(configYaml(fake, 'allow', [root]), fake.password);
  const send = (sessionId: string, workspace?: string) =>
    fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': sessionId,
        ...(workspace ? { 'x-code2api-workspace': workspace } : {}),
      },
      body: JSON.stringify({
        model: 'oc-test',
        messages: [{ role: 'user', content: 'ws' }],
      }),
    });
  try {
    const first = await send('oc-workspace-1', wsA);
    assert.equal(first.status, 200);
    assert.equal(fake.createdLocations.at(-1), realpathSync.native(wsA));

    const sameAgain = await send('oc-workspace-1', wsA);
    assert.equal(sameAgain.status, 200);
    assert.equal(fake.createdLocations.length, 1);

    const switched = await send('oc-workspace-1', wsB);
    assert.equal(switched.status, 400);
    const switchedBody = await switched.json();
    assert.match(switchedBody.error.message, /该会话已绑定工作区/);

    const denied = await send('oc-workspace-1', outside);
    assert.equal(denied.status, 400);
    const deniedBody = await denied.json();
    assert.match(deniedBody.error.message, /工作区不在允许的根目录内/);

    const relative = await send('oc-workspace-1', 'proj-a');
    assert.equal(relative.status, 400);
    const relativeBody = await relative.json();
    assert.match(relativeBody.error.message, /工作区必须是绝对路径/);
  } finally {
    await harness.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('kilo 风味：/config 就绪、无 type 模型目录、DELETE 会话 404 容错', async () => {
  const fake = new FakeOpenCode();
  fake.flavor = 'kilo';
  await fake.start();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-kilo
    type: opencode
    flavor: kilo
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    auto_models: true
    startup_timeout_ms: 15000
    models: []
`, fake.password);
  try {
    // 就绪探针走 /config（/api/info 在 kilo 下 404）；自动发现不再按 type 过滤。
    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    const ids = models.data.map((m: any) => m.id);
    assert.ok(ids.includes('vendor/auto-model'));
    assert.ok(!ids.includes('vendor/fake-image'));

    const admin = await adminGet(harness, '/admin/api/models');
    const auto = admin.models.find((m: any) => m.id === 'vendor/auto-model');
    assert.ok(auto);
    assert.equal(auto.source, 'upstream');
    assert.equal(auto.contextWindow, 100000);
    assert.equal(auto.upstream, 'fake/vendor/auto-model');

    // 不带 x-code2api-session => oneShot，收尾 DELETE 会话在 kilo 下 404，必须不影响响应。
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'vendor/auto-model',
        messages: [{ role: 'user', content: 'kilo hello' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'fake reply: kilo hello');
    assert.deepEqual(fake.modelSelections.at(-1), {
      providerID: 'fake',
      id: 'vendor/auto-model',
    });
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('kilo 风味：model_filter 只放行 *:free 模型', async () => {
  const fake = new FakeOpenCode();
  fake.flavor = 'kilo';
  await fake.start();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-kilo-free
    type: opencode
    flavor: kilo
    model_filter:
      - "*:free"
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    auto_models: true
    models: []
`, fake.password);
  try {
    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    const ids = models.data.map((m: any) => m.id);
    assert.ok(ids.includes('vendor/free-chat:free'));
    assert.ok(!ids.includes('vendor/auto-model'));
    assert.ok(!ids.includes('vendor/fake-image'));

    // 被过滤的付费模型不可路由。
    const paid = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'vendor/auto-model',
        messages: [{ role: 'user', content: 'should not route' }],
      }),
    });
    assert.equal(paid.status, 404);

    // 免费模型正常执行。
    const free = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'vendor/free-chat:free',
        messages: [{ role: 'user', content: 'free hello' }],
      }),
    });
    assert.equal(free.status, 200);
    const body = await free.json();
    assert.equal(body.choices[0].message.content, 'fake reply: free hello');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 风味：model_filter 支持 providerID/modelID 白名单（订阅渠道）', async () => {
  const fake = new FakeOpenCode();
  // 模拟订阅渠道：上游出现独立 provider fake-go，付费模型不带 free 字样。
  fake.goModels = [
    {
      id: 'glm-9',
      modelID: 'glm-9',
      providerID: 'fake-go',
      type: 'chat',
      enabled: true,
      status: 'active',
      capabilities: { tools: true, input: ['text'] },
      limit: { context: 1000000, output: 65536 },
      cost: [{ input: 1, output: 3, cache: { read: 0.1, write: 0.2 } }],
    },
  ];
  await fake.start();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-oc-go
    type: opencode
    model_filter:
      - "*free*"
      - "fake-go/*"
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    auto_models: true
    models: []
`, fake.password);
  try {
    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    const ids = models.data.map((m: any) => m.id);
    // provider 限定白名单放行订阅付费模型；裸 modelID 模式仍按旧语义匹配。
    assert.ok(ids.includes('glm-9'));
    assert.ok(!ids.includes('auto-model'), '不匹配 *free* 的原 provider 模型仍被过滤');

    // 订阅付费模型可正常路由执行。
    const paid = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-9',
        messages: [{ role: 'user', content: 'go hello' }],
      }),
    });
    assert.equal(paid.status, 200);
    const body = await paid.json();
    assert.equal(body.choices[0].message.content, 'fake reply: go hello');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 自动发现：model_prefixes 按上游给对外名加前缀（订阅渠道）', async () => {
  const fake = new FakeOpenCode();
  fake.goModels = [
    {
      id: 'glm-9',
      modelID: 'glm-9',
      providerID: 'fake-go',
      type: 'chat',
      enabled: true,
      status: 'active',
      capabilities: { tools: true, input: ['text'] },
      limit: { context: 1000000, output: 65536 },
      cost: [{ input: 1, output: 3, cache: { read: 0.1, write: 0.2 } }],
    },
  ];
  await fake.start();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-oc-go
    type: opencode
    model_filter:
      - "*free*"
      - "fake-go/*"
    model_prefixes:
      "fake-go/*": "Go/"
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    auto_models: true
    models: []
`, fake.password);
  try {
    const models = await fetch(`${harness.base}/v1/models`).then((r) => r.json());
    const ids = models.data.map((m: any) => m.id);
    // 订阅渠道模型带前缀，原始裸名不应再出现。
    assert.ok(ids.includes('Go/glm-9'), `应包含 Go/glm-9，实际 ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes('glm-9'), '原始裸名不应再出现');

    const channels = await adminGet(harness, '/admin/api/channels');
    const synced = channels.channels
      .find((c: any) => c.id === 'fake-oc-go')
      .models.find((m: any) => m.id === 'Go/glm-9');
    assert.equal(synced.upstream, 'fake-go/glm-9');
    assert.equal(synced.source, 'upstream');
    assert.equal(synced.contextWindow, 1000000);

    // 前缀名可正常路由执行。
    const routed = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'Go/glm-9',
        messages: [{ role: 'user', content: 'go hello' }],
      }),
    });
    assert.equal(routed.status, 200);
    const body = await routed.json();
    assert.equal(body.choices[0].message.content, 'fake reply: go hello');
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 桥接：usage 分离——客户端=末步，记账=累加', async () => {
  const fake = new FakeOpenCode();
  // 模拟内部 agent 循环跑了两个 step：客户端应看到末步（当前对话规模），
  // 面板/计费应看到累加（上游真实消耗），否则客户端上下文仪表被撑爆。
  fake.stepPlan = [
    { input: 1000, output: 100, reasoning: 200, cacheRead: 500, cacheWrite: 0 },
    { input: 2000, output: 150, reasoning: 300, cacheRead: 4000, cacheWrite: 0 },
  ];
  await fake.start();
  const harness = await startGateway(configYaml(fake, 'allow'), fake.password);
  try {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'oc-test',
        messages: [{ role: 'user', content: 'usage split' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    // 客户端可见 = 末步快照（不是累加值）。
    assert.equal(body.usage.prompt_tokens, 2000);
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 4000);
    assert.equal(body.usage.completion_tokens, 150);
    assert.equal(body.usage.completion_tokens_details.reasoning_tokens, 300);

    // 记账 = 累加（openai 口径启发式下 cr>in 视为桥接行：未缓存=input 原值）。
    const overview = await adminGet(harness, '/admin/api/overview');
    assert.equal(overview.totals.uncachedInputTokens, 3000);
    assert.equal(overview.totals.cacheReadTokens, 4500);
    assert.equal(overview.totals.generatedTokens, 250 + 500);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('kilo 风味：面板保存渠道 flavor 往返', async () => {
  const fake = new FakeOpenCode();
  fake.flavor = 'kilo';
  await fake.start();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-kilo
    type: opencode
    flavor: kilo
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    auto_models: true
    models: []
`, fake.password);
  try {
    const channels = await adminGet(harness, '/admin/api/channels');
    const channel = channels.channels.find((c: any) => c.id === 'fake-kilo');
    assert.equal(channel.opencode.flavor, 'kilo');

    // 面板编辑：改优先级，flavor 必须保留并写回 YAML。
    const save = await fetch(`${harness.base}/admin/api/channels/fake-kilo`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${harness.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'fake-kilo',
        type: 'opencode',
        flavor: 'kilo',
        priority: 20,
        enabled: true,
        baseUrl: fake.baseUrl,
        autoModels: true,
        keys: [],
        models: [],
      }),
    });
    assert.equal(save.status, 200);
    const after = await adminGet(harness, '/admin/api/channels');
    const updated = after.channels.find((c: any) => c.id === 'fake-kilo');
    assert.equal(updated.opencode.flavor, 'kilo');
    assert.equal(updated.priority, 20);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('opencode 推理等级：reasoning_effort 映射会话 variant 并可重置', async () => {
  const fake = new FakeOpenCode();
  await fake.start();
  const harness = await startGateway(configYaml(fake, 'allow'), fake.password);
  const send = (reasoningEffort?: string) =>
    fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-code2api-session': 'oc-reason-1',
      },
      body: JSON.stringify({
        model: 'auto-model',
        messages: [{ role: 'user', content: 'reason' }],
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
    });
  try {
    const first = await send('high');
    assert.equal(first.status, 200);
    assert.deepEqual(fake.modelSelections.at(-1), {
      providerID: 'fake',
      id: 'auto-model',
      variant: 'high',
    });

    const second = await send();
    assert.equal(second.status, 200);
    assert.deepEqual(fake.modelSelections.at(-1), {
      providerID: 'fake',
      id: 'auto-model',
    });
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('kilo 风味：reasoning_effort 映射为会话 variant', async () => {
  const fake = new FakeOpenCode();
  fake.flavor = 'kilo';
  await fake.start();
  const harness = await startGateway(`
server:
  port: 0
admin:
  token: test-admin
storage:
  path: __DB__
providers:
  - id: fake-kilo
    type: opencode
    flavor: kilo
    priority: 10
    base_url: ${fake.baseUrl}
    password_env: C2A_TEST_OC_PASSWORD
    auto_models: true
    startup_timeout_ms: 15000
    models: []
`, fake.password);
  try {
    // kilo 模型目录不带 variants，但档位经会话级 variant 生效：能力必须放行。
    const admin = await adminGet(harness, '/admin/api/models');
    const auto = admin.models.find((m: any) => m.id === 'vendor/auto-model');
    assert.ok(auto);
    assert.equal(auto.capabilities.reasoning, true);

    // 客户端发 reasoning_effort（任意大小写）→ 会话 variant 小写透传。
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'vendor/auto-model',
        messages: [{ role: 'user', content: 'kilo think' }],
        reasoning_effort: 'High',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(fake.modelSelections.at(-1), {
      providerID: 'fake',
      id: 'vendor/auto-model',
      variant: 'high',
    });

    // 不发 reasoning_effort → 不带 variant（kilo 服务端自填 "default"）。
    const plain = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'vendor/auto-model',
        messages: [{ role: 'user', content: 'kilo plain' }],
      }),
    });
    assert.equal(plain.status, 200);
    assert.deepEqual(fake.modelSelections.at(-1), {
      providerID: 'fake',
      id: 'vendor/auto-model',
    });
  } finally {
    await harness.close();
    await fake.close();
  }
});
