import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSseTransformer } from '../src/adapter/sse.ts';

function buildChunk(content) {
  return {
    id: 'chatcmpl-guardrail',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'guardrail-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

async function runSseTransform(chunks) {
  const encoder = new TextEncoder();
  const input = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  const output = input.pipeThrough(createSseTransformer('as_reasoning_content'));
  return await new Response(output).text();
}

test('SSE guardrail: JSON split across chunk boundaries should still emit one valid event', async () => {
  const payload = JSON.stringify(buildChunk('Hello from split chunk'));
  const cut = Math.floor(payload.length / 2);

  const output = await runSseTransform([
    `data: ${payload.slice(0, cut)}`,
    `${payload.slice(cut)}\n\n`,
    'data: [DONE]\n\n',
  ]);

  const expected = `data: ${payload}\n\ndata: [DONE]\n\n`;
  assert.equal(output, expected);
});

test('SSE guardrail: CRLF input should normalize and keep protocol boundaries', async () => {
  const payload = JSON.stringify(buildChunk('Hello from CRLF'));

  const output = await runSseTransform([`data: ${payload}\r\n\r\n`, 'data: [DONE]\r\n\r\n']);

  const expected = `data: ${payload}\n\ndata: [DONE]\n\n`;
  assert.equal(output, expected);
});

test('SSE guardrail: mixed event/id/non-JSON data lines should be preserved', async () => {
  const payload = JSON.stringify(buildChunk('Hello mixed lines'));

  const output = await runSseTransform([
    ['event: message', 'id: 42', 'data: keepalive', 'data: {"oops":', `data: ${payload}`, '', ''].join(
      '\n',
    ),
    ['event: ping', 'id: 43', 'data: noop', '', ''].join('\n'),
  ]);

  const expected = [
    'event: message',
    'id: 42',
    'data: keepalive',
    'data: {"oops":',
    `data: ${payload}`,
    '',
    'event: ping',
    'id: 43',
    'data: noop',
    '',
    '',
  ].join('\n');

  assert.equal(output, expected);
});

test('SSE guardrail: data [DONE] should stay canonical even with extra spaces', async () => {
  const output = await runSseTransform(['id: final\ndata:    [DONE]    \n\n']);
  assert.equal(output, 'id: final\ndata: [DONE]\n\n');
});
