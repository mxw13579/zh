import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { handleRequest } from '../src/adapter/handler.ts';
import { countPromptTokens, getTokenEncoder } from '../src/adapter/tokens.ts';

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

test('OpenAI audit-enabled request with no extractable text does not fail solely for missing text', async () => {
  let upstreamBody = null;
  let auditCalls = 0;

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
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
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

  const response = await fetch(`${adapter.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
      ],
      audit_base_url: audit.baseUrl,
      audit_token: 'audit-token',
      audit_categories: ['violence/graphic:0.9'],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(auditCalls, 0);
  assert.ok(upstreamBody);
  assert.equal(upstreamBody.audit_base_url, undefined);
  assert.equal(upstreamBody.audit_token, undefined);
  assert.equal(upstreamBody.audit_categories, undefined);
  assert.deepEqual(upstreamBody.messages?.[0]?.content, [
    { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
  ]);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
  await stopServer(audit.server);
});

test('stream usage patch fills missing/zero prompt and completion tokens', async () => {
  const upstream = await startHttpServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.end(
      [
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'x',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }],
        })}`,
        '',
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'x',
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
        })}`,
        '',
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'x',
          choices: [],
          usage: { prompt_tokens: 0, total_tokens: 0 },
        })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const requestBody = { messages: [{ role: 'user', content: 'hi' }], stream: true };

  const response = await fetch(`${adapter.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'Adapter-Method': 'void-adapter-1',
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  assert.equal(response.status, 200);
  const sse = await response.text();

  const dataPayloads = sse
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== '[DONE]' && payload[0] === '{')
    .map((payload) => JSON.parse(payload));

  const usageChunk = dataPayloads.find((item) => item && typeof item === 'object' && item.usage);
  assert.ok(usageChunk && usageChunk.usage);

  const expectedPrompt = countPromptTokens(requestBody.messages, null);
  assert.equal(expectedPrompt.ok, true);

  const encoder = getTokenEncoder(null);
  const expectedCompletion = encoder.encode('Hello world').length;
  encoder.free();

  assert.equal(usageChunk.usage.prompt_tokens, expectedPrompt.value);
  assert.equal(usageChunk.usage.completion_tokens, expectedCompletion);
  assert.equal(usageChunk.usage.total_tokens, expectedPrompt.value + expectedCompletion);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
});

test('stream usage patch only fills empty fields', async () => {
  const upstream = await startHttpServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.end(
      [
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'x',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }],
        })}`,
        '',
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'x',
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
        })}`,
        '',
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'x',
          choices: [],
          usage: { prompt_tokens: 0, completion_tokens: 999, total_tokens: 999 },
        })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
    );
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const requestBody = { messages: [{ role: 'user', content: 'hi' }], stream: true };

  const response = await fetch(`${adapter.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'Adapter-Method': 'void-adapter-1',
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  assert.equal(response.status, 200);
  const sse = await response.text();

  const dataPayloads = sse
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== '[DONE]' && payload[0] === '{')
    .map((payload) => JSON.parse(payload));

  const usageChunk = dataPayloads.find((item) => item && typeof item === 'object' && item.usage);
  assert.ok(usageChunk && usageChunk.usage);

  const expectedPrompt = countPromptTokens(requestBody.messages, null);
  assert.equal(expectedPrompt.ok, true);

  assert.equal(usageChunk.usage.prompt_tokens, expectedPrompt.value);
  assert.equal(usageChunk.usage.completion_tokens, 999);
  assert.equal(usageChunk.usage.total_tokens, expectedPrompt.value + 999);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
});

test('OPTIONS CORS includes Adapter-Audit-* headers', async () => {
  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'OPTIONS',
  });

  assert.equal(response.status, 204);
  const allowHeaders = response.headers.get('access-control-allow-headers') ?? '';
  assert.match(allowHeaders, /Adapter-Audit-Base-URL/i);
  assert.match(allowHeaders, /Adapter-Audit-Token/i);
  assert.match(allowHeaders, /Adapter-Audit-Categories/i);

  await stopServer(adapter.server);
});

test('non-JSON passthrough strips adapter-private headers before upstream', async () => {
  let upstreamHeaders = null;

  const upstream = await startHttpServer((req, res) => {
    upstreamHeaders = req.headers;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('ok');
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/messages?foo=1`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'Adapter-Audit-Base-URL': 'https://audit.local',
      'Adapter-Audit-Token': 'audit-token',
      'Adapter-Audit-Categories': 'violence/graphic:0.9',
      'content-type': 'application/octet-stream',
    },
    body: 'raw-binary-body',
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.ok(upstreamHeaders);
  assert.equal(upstreamHeaders['adapter-authorization'], undefined);
  assert.equal(upstreamHeaders['upstream-base-url'], undefined);
  assert.equal(upstreamHeaders['adapter-method'], undefined);
  assert.equal(upstreamHeaders['adapter-audit-base-url'], undefined);
  assert.equal(upstreamHeaders['adapter-audit-token'], undefined);
  assert.equal(upstreamHeaders['adapter-audit-categories'], undefined);
  assert.equal(upstreamHeaders['safety-parameters'], undefined);
  assert.equal(upstreamHeaders['prompt-tokens-max'], undefined);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
});

test('Claude non-JSON request rejects Safety-Parameters before upstream is called', async () => {
  let upstreamCalls = 0;

  const upstream = await startHttpServer((_req, res) => {
    upstreamCalls += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('ok');
  });

  const runtime = createRuntimeConfig();
  const adapter = await startHttpServer((req, res) => void handleRequest(req, res, runtime));

  const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Adapter-Authorization': 'secret',
      'UPSTREAM-BASE-URL': upstream.baseUrl,
      'Safety-Parameters': 'false',
      'content-type': 'application/octet-stream',
    },
    body: 'raw-body',
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error?.type, 'invalid_request_error');
  assert.equal(upstreamCalls, 0);

  await stopServer(adapter.server);
  await stopServer(upstream.server);
});
