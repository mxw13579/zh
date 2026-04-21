import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { handleRequest } from '../src/adapter/handler.ts';

function createRuntimeConfig(overrides = {}) {
  return {
    allowOrigin: '*',
    adapterAuthorization: 'secret',
    port: 0,
    reasoningStrategy: 'as_reasoning_content',
    ...overrides,
  };
}

function startHttpServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
      });
    });
  });
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

test('Claude route forwards to /v1/messages and preserves body except stripped audit controls', async () => {
  let receivedUrl = null;
  let upstreamBody = null;

  const upstream = await startHttpServer(async (req, res) => {
    receivedUrl = req.url;
    upstreamBody = await readJson(req);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'Hello from Claude' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    );
  });

  const audit = await startHttpServer(async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'modr-test',
        model: 'text-moderation-latest',
        results: [
          {
            flagged: false,
            categories: {},
            category_scores: { 'violence/graphic': 0.1 },
          },
        ],
      }),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/messages?foo=1`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 256,
      system: 'You are Claude.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          ],
        },
      ],
      audit_base_url: audit.baseUrl,
      audit_token: 'audit-token',
      audit_categories: ['violence/graphic:0.9'],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(receivedUrl, '/v1/messages?foo=1');
  assert.ok(upstreamBody);
  assert.equal(upstreamBody.audit_base_url, undefined);
  assert.equal(upstreamBody.audit_token, undefined);
  assert.equal(upstreamBody.audit_categories, undefined);
  assert.equal(upstreamBody.system, 'You are Claude.');
  assert.deepEqual(upstreamBody.messages?.[0]?.content?.[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'abc' },
  });

  const body = await response.json();
  assert.equal(body.type, 'message');
  assert.equal(body.content?.[0]?.text, 'Hello from Claude');

  await stopServer(adapter.server);
  await stopServer(audit.server);
  await stopServer(upstream.server);
});

test('Claude route rejects OpenAI-only Adapter-Method before upstream is called', async () => {
  let upstreamCalls = 0;

  const upstream = await startHttpServer((_req, res) => {
    upstreamCalls += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'Adapter-Method': 'void-adapter-1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error?.type, 'invalid_request_error');
  assert.equal(upstreamCalls, 0);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
});

test('Claude route accepts audit controls from headers and strips them before upstream', async () => {
  let upstreamBody = null;
  let moderationInputs = null;

  const upstream = await startHttpServer(async (req, res) => {
    upstreamBody = await readJson(req);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    );
  });

  const audit = await startHttpServer(async (req, res) => {
    const body = await readJson(req);
    moderationInputs = body.input;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'modr-test',
        model: 'text-moderation-latest',
        results: [{ flagged: false, categories: {}, category_scores: { 'violence/graphic': 0.1 } }],
      }),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'Adapter-Audit-Base-URL': audit.baseUrl,
      'Adapter-Audit-Token': 'audit-token',
      'Adapter-Audit-Categories': 'violence/graphic:0.9',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      system: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello header audit' }] }],
    }),
  });

  assert.equal(response.status, 200);
  assert.ok(upstreamBody);
  assert.equal(upstreamBody.audit_base_url, undefined);
  assert.equal(upstreamBody.audit_token, undefined);
  assert.equal(upstreamBody.audit_categories, undefined);
  assert.deepEqual(moderationInputs, ['sys', 'hello header audit']);

  await stopServer(adapter.server);
  await stopServer(audit.server);
  await stopServer(upstream.server);
});

test('Claude audit only inspects extractable text and forwards non-text content unchanged', async () => {
  let moderationInputs = null;
  let upstreamBody = null;

  const upstream = await startHttpServer(async (req, res) => {
    upstreamBody = await readJson(req);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    );
  });

  const audit = await startHttpServer(async (req, res) => {
    const body = await readJson(req);
    moderationInputs = body.input;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'modr-test',
        model: 'text-moderation-latest',
        results: [{ flagged: false, categories: {}, category_scores: { 'violence/graphic': 0.1 } }],
      }),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const mixedContent = [
    { type: 'text', text: 'audit this only' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: 'abc' } },
  ];

  const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: mixedContent }],
      audit_base_url: audit.baseUrl,
      audit_token: 'audit-token',
      audit_categories: ['violence/graphic:0.9'],
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(moderationInputs, 'audit this only');
  assert.deepEqual(upstreamBody.messages?.[0]?.content, mixedContent);

  await stopServer(adapter.server);
  await stopServer(audit.server);
  await stopServer(upstream.server);
});

test('Claude route rejects Prompt-Tokens-Max and Safety-Parameters controls', async () => {
  let upstreamCalls = 0;

  const upstream = await startHttpServer((_req, res) => {
    upstreamCalls += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const promptLimitResponse = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'Prompt-Tokens-Max': '80k',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assert.equal(promptLimitResponse.status, 400);

  const safetyResponse = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'Safety-Parameters': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assert.equal(safetyResponse.status, 400);
  assert.equal(upstreamCalls, 0);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
});

test('Claude audit-enabled request with no extractable text does not fail solely for missing text', async () => {
  let auditCalls = 0;
  let upstreamBody = null;

  const upstream = await startHttpServer(async (req, res) => {
    upstreamBody = await readJson(req);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    );
  });

  const audit = await startHttpServer(async (_req, res) => {
    auditCalls += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'modr-test',
        model: 'text-moderation-latest',
        results: [{ flagged: false, categories: {}, category_scores: { 'violence/graphic': 0.1 } }],
      }),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const nonTextBlocks = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: 'abc' } },
  ];

  const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      messages: [{ role: 'user', content: nonTextBlocks }],
      audit_base_url: audit.baseUrl,
      audit_token: 'audit-token',
      audit_categories: ['violence/graphic:0.9'],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(auditCalls, 0);
  assert.deepEqual(upstreamBody.messages?.[0]?.content, nonTextBlocks);

  await stopServer(adapter.server);
  await stopServer(audit.server);
  await stopServer(upstream.server);
});

test('Claude native SSE events pass through unchanged', async () => {
  const upstreamSse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: ping',
    'data: {"type":"ping"}',
    '',
    'event: custom_event',
    'data: {"type":"custom_event","x":1}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const upstream = await startHttpServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.end(upstreamSse);
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), upstreamSse);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
});
