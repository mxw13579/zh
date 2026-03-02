import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTaggedLogLine, isAuditRawRedactionEnabled } from '../src/adapter/log.ts';
import { checkAdapterAuthorization, constantTimeEqual } from '../src/adapter/utils/auth.ts';

function parseTaggedLog(line) {
  const sep = line.indexOf('] ');
  return JSON.parse(line.slice(sep + 2));
}

test('AUDIT_REDACT_RAW defaults to disabled unless equal to 1', () => {
  assert.equal(isAuditRawRedactionEnabled({}), false);
  assert.equal(isAuditRawRedactionEnabled({ AUDIT_REDACT_RAW: '0' }), false);
  assert.equal(isAuditRawRedactionEnabled({ AUDIT_REDACT_RAW: 'true' }), false);
  assert.equal(isAuditRawRedactionEnabled({ AUDIT_REDACT_RAW: '1' }), true);
});

test('buildTaggedLogLine keeps raw unchanged by default', () => {
  const line = buildTaggedLogLine(
    'audit',
    {
      stage: 'response',
      raw: '{"secret":"token"}',
    },
    { env: {} },
  );

  const payload = parseTaggedLog(line);
  assert.equal(payload.raw, '{"secret":"token"}');
});

test('buildTaggedLogLine redacts raw when AUDIT_REDACT_RAW=1', () => {
  const line = buildTaggedLogLine(
    'audit',
    {
      stage: 'response',
      raw: '{"secret":"token"}',
    },
    { env: { AUDIT_REDACT_RAW: '1' } },
  );

  const payload = parseTaggedLog(line);
  assert.equal(payload.raw, '[REDACTED] 18 chars');
});

test('buildTaggedLogLine redacts non-string raw when redaction enabled', () => {
  const line = buildTaggedLogLine(
    'audit',
    {
      stage: 'response',
      raw: { secret: 'token' },
    },
    { env: { AUDIT_REDACT_RAW: '1' } },
  );

  const payload = parseTaggedLog(line);
  assert.equal(payload.raw, '[REDACTED]');
});

test('constantTimeEqual returns expected equality semantics', () => {
  assert.equal(constantTimeEqual('secret', 'secret'), true);
  assert.equal(constantTimeEqual('secret', 'secret2'), false);
  assert.equal(constantTimeEqual('secret', 'secret '), false);
  assert.equal(constantTimeEqual('', ''), true);
});

test('checkAdapterAuthorization preserves existing auth outcomes', () => {
  assert.deepEqual(checkAdapterAuthorization(undefined, 'secret'), {
    ok: false,
    reason: 'missing',
  });
  assert.deepEqual(checkAdapterAuthorization(['secret'], 'secret'), {
    ok: false,
    reason: 'invalid_type',
  });
  assert.deepEqual(checkAdapterAuthorization('wrong', 'secret'), {
    ok: false,
    reason: 'mismatch',
  });
  assert.deepEqual(checkAdapterAuthorization('  secret  ', 'secret'), {
    ok: true,
  });
});
