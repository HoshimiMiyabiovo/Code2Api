import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http/app.js';

interface Fake {
  baseUrl: string;
  bodies: Array<Record<string, any>>;
  close: () => Promise<void>;
}

async function startFake(): Promise<Fake> {
  const bodies: Array<Record<string, any>> = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    bodies.push(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m: any) => m?.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const wantTool = userText.includes('tool');
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({
        id: 'fake-stream',
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      send({
        id: 'fake-stream',
        model: body.model,
        choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }],
      });
      send({
        id: 'fake-stream',
        model: body.model,
        choices: [{ index: 0, delta: { content: userText }, finish_reason: null }],
      });
      send({
        id: 'fake-stream',
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      send({
        id: 'fake-stream',
        model: body.model,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (wantTool) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fake-tool',
          object: 'chat.completion',
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":"x"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'fake',
        object: 'chat.completion',
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `Hello ${userText}` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    bodies,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

interface Harness {
  base: string;
  gateway: Gateway;
  close: () => Promise<void>;
}

async function startGateway(yaml: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'code2api-responses-'));
  const dbPath = join(dir, 'gateway.db').replaceAll('\\', '/');
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, yaml.replaceAll('__DB__', dbPath), 'utf8');
  const config = loadConfig(configPath);
  const gateway = await createGateway(config, { configPath });
  await gateway.app.listen({ host: '127.0.0.1', port: 0 });
  const address = gateway.app.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    gateway,
    close: async () => {
      await gateway.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function configYaml(fake: Fake): string {
  return `
server:
  port: 0
storage:
  path: __DB__
catalog:
  sync_enabled: false
providers:
  - id: fake
    type: openai-compatible
    base_url: ${fake.baseUrl}/v1
    keys:
      - label: main
        key: ok-key
    models:
      - id: chat-model
        upstream: up-chat
        context_window: 100000
`;
}

test('Responses 非流式、流式与工具调用', async () => {
  const fake = await startFake();
  const harness = await startGateway(configYaml(fake));
  try {
    const basic = await fetch(`${harness.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat-model', input: 'hello' }),
    });
    assert.equal(basic.status, 200);
    const basicBody = await basic.json();
    assert.equal(basicBody.object, 'response');
    assert.equal(basicBody.status, 'completed');
    assert.equal(basicBody.output_text, 'Hello hello');
    assert.equal(basicBody.output[0].type, 'message');
    assert.equal(basicBody.usage.input_tokens, 7);
    assert.equal(basicBody.usage.output_tokens, 2);

    const tool = await fetch(`${harness.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat-model', input: 'use tool' }),
    });
    assert.equal(tool.status, 200);
    const toolBody = await tool.json();
    const functionCall = toolBody.output.find((item: any) => item.type === 'function_call');
    assert.ok(functionCall);
    assert.equal(functionCall.call_id, 'call_1');
    assert.equal(functionCall.name, 'lookup');
    assert.equal(functionCall.arguments, '{"q":"x"}');

    const stream = await fetch(`${harness.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat-model', input: 'stream', stream: true }),
    });
    assert.equal(stream.status, 200);
    const sse = await stream.text();
    assert.match(sse, /event: response.created/);
    assert.match(sse, /event: response.output_text.delta/);
    assert.match(sse, /event: response.output_text.done/);
    assert.match(sse, /event: response.completed/);
    assert.match(sse, /"output_text":"Hello stream"/);
    assert.match(sse, /"usage":\{"input_tokens":10/);
  } finally {
    await harness.close();
    await fake.close();
  }
});

test('Responses previous_response_id 延续上下文', async () => {
  const fake = await startFake();
  const harness = await startGateway(configYaml(fake));
  try {
    const first = await fetch(`${harness.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat-model', input: 'one' }),
    });
    const firstBody = await first.json();
    assert.equal(firstBody.output_text, 'Hello one');

    const second = await fetch(`${harness.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'chat-model',
        input: 'two',
        previous_response_id: firstBody.id,
      }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.previous_response_id, firstBody.id);
    assert.equal(secondBody.output_text, 'Hello two');

    const lastBody = fake.bodies.at(-1);
    assert.ok(Array.isArray(lastBody?.messages));
    const roles = (lastBody?.messages as any[]).map((message) => message.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user']);
    assert.equal((lastBody?.messages as any[])[1].content, 'Hello one');
    assert.equal((lastBody?.messages as any[])[2].content, 'two');

    const missing = await fetch(`${harness.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'chat-model',
        input: 'three',
        previous_response_id: 'resp_missing',
      }),
    });
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.error.code, 'previous_response_not_found');
  } finally {
    await harness.close();
    await fake.close();
  }
});
