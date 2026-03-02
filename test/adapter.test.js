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

test('rejects when Adapter-Authorization missing', async () => {
  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'UPSTREAM-BASE-URL': 'http://example.com',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(response.status, 401);

  await stopServer(adapter.server);
});

test('rejects unknown adapter-method', async () => {
  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': 'http://example.com',
      'Adapter-Method': 'unknown',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(response.status, 400);

  await stopServer(adapter.server);
});

test('UPSTREAM-BASE-URL supports path prefix and forces /v1/chat/completions', async () => {
  let receivedUrl = null;

  const upstream = await startHttpServer((req, res) => {
    receivedUrl = req.url;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'x',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
      }),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/anything?foo=1`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': `${upstream.baseUrl}/prefix`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(response.status, 200);
  assert.equal(receivedUrl, '/prefix/v1/chat/completions?foo=1');

  await stopServer(adapter.server);
  await stopServer(upstream.server);
});

test('audit passes and audit_* fields are stripped before upstream', async () => {
  let upstreamBody = null;

  const upstream = await startHttpServer(async (req, res) => {
    upstreamBody = await readJson(req);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'x',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: '',
              reasoning_content: [{ type: 'thinking', thinking: 'ok' }],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  });

  const audit = await startHttpServer(async (req, res) => {
    const body = await readJson(req);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'modr-test',
        model: 'text-moderation-latest',
        results: inputs.map(() => ({
          flagged: false,
          categories: {},
          category_scores: { 'sexual/minors': 0.1, 'violence/graphic': 0.1 },
        })),
      }),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'Adapter-Method': 'void-adapter-1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'prev' },
        { role: 'user', content: 'last user' },
      ],
      audit_base_url: audit.baseUrl,
      audit_token: 'audit-token',
      audit_categories: ['sexual/minors:0.8', 'violence/graphic:0.9'],
    }),
  });

  assert.equal(response.status, 200);
  assert.ok(upstreamBody);
  assert.equal(upstreamBody.audit_base_url, undefined);
  assert.equal(upstreamBody.audit_token, undefined);
  assert.equal(upstreamBody.audit_categories, undefined);

  const normalized = await response.json();
  assert.equal(normalized.choices?.[0]?.delta?.reasoning_content, 'ok');

  await stopServer(adapter.server);
  await stopServer(upstream.server);
  await stopServer(audit.server);
});

test('when Adapter-Method is missing, response is returned natively (no conversion)', async () => {
  const upstream = await startHttpServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'x',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: '',
              reasoning_content: [{ type: 'thinking', thinking: 'native' }],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Array.isArray(body.choices?.[0]?.delta?.reasoning_content), true);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
});

test('audit blocks when any category_score exceeds threshold and upstream is not called', async () => {
  let upstreamCalls = 0;

  const upstream = await startHttpServer((_req, res) => {
    upstreamCalls += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
  });

  const audit = await startHttpServer(async (req, res) => {
    const body = await readJson(req);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        id: 'modr-test',
        model: 'text-moderation-latest',
        results: inputs.map(() => ({
          flagged: false,
          categories: {},
          category_scores: { 'sexual/minors': 0.95, 'violence/graphic': 0.1 },
        })),
      }),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'assistant', content: 'prev' }, { role: 'user', content: 'last user' }],
      audit_base_url: audit.baseUrl,
      audit_token: 'audit-token',
      audit_categories: ['sexual/minors:0.8', 'violence/graphic:0.9'],
    }),
  });

  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.error?.type, 'content_audit_failed');
  assert.match(payload.error?.message ?? '', /category=sexual\/minors/);
  assert.match(payload.error?.message ?? '', /maxScore=0.8/);
  assert.match(payload.error?.message ?? '', /score=0.95/);
  assert.equal(upstreamCalls, 0);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
  await stopServer(audit.server);
});
