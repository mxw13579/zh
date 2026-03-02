import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUDIT_BASE_URL_ERROR_MESSAGES,
  UPSTREAM_BASE_URL_ERROR_MESSAGES,
  joinBaseUrlWithV1Endpoint,
  parseHttpBaseUrl,
  parseHttpBaseUrlOrThrow,
} from '../src/adapter/utils/url.ts';

test('parseHttpBaseUrlOrThrow normalizes trailing slash for valid upstream base URL', () => {
  const parsed = parseHttpBaseUrlOrThrow('http://example.com/prefix', UPSTREAM_BASE_URL_ERROR_MESSAGES);
  assert.equal(parsed, 'http://example.com/prefix/');
});

test('parseHttpBaseUrlOrThrow rejects invalid upstream base URL syntax', () => {
  assert.throws(
    () => parseHttpBaseUrlOrThrow('not-a-url', UPSTREAM_BASE_URL_ERROR_MESSAGES),
    { message: 'Invalid UPSTREAM-BASE-URL' },
  );
});

test('parseHttpBaseUrlOrThrow rejects non-http protocol for upstream base URL', () => {
  assert.throws(
    () => parseHttpBaseUrlOrThrow('ftp://example.com', UPSTREAM_BASE_URL_ERROR_MESSAGES),
    { message: 'UPSTREAM-BASE-URL must be an http(s) URL' },
  );
});

test('parseHttpBaseUrlOrThrow rejects credentials for upstream base URL', () => {
  assert.throws(
    () => parseHttpBaseUrlOrThrow('http://user:pass@example.com', UPSTREAM_BASE_URL_ERROR_MESSAGES),
    { message: 'UPSTREAM-BASE-URL must not include credentials' },
  );
});

test('parseHttpBaseUrlOrThrow rejects query/hash for upstream base URL', () => {
  assert.throws(
    () => parseHttpBaseUrlOrThrow('https://example.com/path?x=1#y', UPSTREAM_BASE_URL_ERROR_MESSAGES),
    { message: 'UPSTREAM-BASE-URL must not include query or hash' },
  );
});

test('parseHttpBaseUrl returns union result for audit_base_url validation errors', () => {
  const invalidProtocol = parseHttpBaseUrl('ftp://example.com', AUDIT_BASE_URL_ERROR_MESSAGES);
  assert.deepEqual(invalidProtocol, { ok: false, error: 'audit_base_url must be an http(s) URL' });

  const invalidSyntax = parseHttpBaseUrl('not-a-url', AUDIT_BASE_URL_ERROR_MESSAGES);
  assert.deepEqual(invalidSyntax, { ok: false, error: 'audit_base_url must be a valid http(s) URL' });
});

test('joinBaseUrlWithV1Endpoint appends /v1 when missing', () => {
  const joined = joinBaseUrlWithV1Endpoint('https://api.example.com/prefix/', 'chat/completions');
  assert.equal(joined.toString(), 'https://api.example.com/prefix/v1/chat/completions');
});

test('joinBaseUrlWithV1Endpoint avoids duplicate /v1 when already present', () => {
  const joined = joinBaseUrlWithV1Endpoint('https://api.example.com/prefix/v1/', 'moderations');
  assert.equal(joined.toString(), 'https://api.example.com/prefix/v1/moderations');
});

test('joinBaseUrlWithV1Endpoint tolerates leading slash in endpoint', () => {
  const joined = joinBaseUrlWithV1Endpoint('https://api.example.com/v1/', '/chat/completions');
  assert.equal(joined.toString(), 'https://api.example.com/v1/chat/completions');
});

