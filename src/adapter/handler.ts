import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { extractAuditInputs, runAudit, splitAuditConfig, type AuditThresholdFailure } from './audit.js';
import { type RuntimeConfig, normalizeBaseUrl } from './config.js';
import { setCorsHeaders } from './cors.js';
import { buildUpstreamHeaders } from './headers.js';
import { getAdapterMethod } from './methods/index.js';
import type { AdapterMethod } from './methods/types.js';
import { relayUpstreamResponse } from './relay.js';
import { sendJson } from './respond.js';

type NodeRequestInit = RequestInit & { duplex?: 'half' };
type JsonRecord = Record<string, unknown>;

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RuntimeConfig,
): Promise<void> {
  setCorsHeaders(response, runtime.allowOrigin);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestId = randomUUID();
  const source = getRequestSource(request);
  writeAdapterLog({ id: requestId, stage: 'start', ...source });

  const authCheck = checkAuthorization(request, runtime);
  writeAdapterLog({
    id: requestId,
    stage: 'auth',
    ok: authCheck.ok,
    ...(authCheck.ok ? {} : { reason: authCheck.reason, ...source }),
  });

  if (!authCheck.ok) {
    sendJson(response, 401, {
      error: {
        message: 'Unauthorized',
        type: 'unauthorized',
      },
    });
    return;
  }

  const upstreamBaseUrlHeader = request.headers['upstream-base-url'];
  if (typeof upstreamBaseUrlHeader !== 'string' || !upstreamBaseUrlHeader.trim()) {
    sendJson(response, 400, {
      error: {
        message: 'Missing required header: UPSTREAM-BASE-URL',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const adapterMethodHeader = request.headers['adapter-method'];
  let adapterMethod: AdapterMethod | null = null;
  if (adapterMethodHeader !== undefined) {
    if (typeof adapterMethodHeader !== 'string') {
      sendJson(response, 400, {
        error: {
          message: 'Invalid Adapter-Method header',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const methodName = adapterMethodHeader.trim();
    if (methodName) {
      adapterMethod = getAdapterMethod(methodName);
      if (!adapterMethod) {
        sendJson(response, 400, {
          error: {
            message: 'Unknown adapter-method',
            type: 'invalid_request_error',
          },
        });
        return;
      }
    }
  }

  const abortController = new AbortController();
  const abortUpstream = (): void => abortController.abort();

  response.on('close', abortUpstream);
  response.on('finish', () => response.off('close', abortUpstream));

  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  let upstreamBaseUrl: string;
  try {
    upstreamBaseUrl = normalizeBaseUrl(stripUrlQueryAndHash(upstreamBaseUrlHeader.trim()));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid UPSTREAM-BASE-URL';
    sendJson(response, 400, {
      error: {
        message,
        type: 'invalid_request_error',
      },
    });
    return;
  }
  // Be tolerant to callers passing base URLs that already include a `/v1` path segment.
  // e.g. `https://api.openai.com/v1` -> `.../v1/chat/completions` (not `.../v1/v1/chat/completions`).
  const upstreamBase = new URL(upstreamBaseUrl);
  const upstreamPath = upstreamBase.pathname.endsWith('/v1/')
    ? 'chat/completions'
    : 'v1/chat/completions';
  const targetUrl = new URL(upstreamPath, upstreamBase);
  targetUrl.search = requestUrl.search;
  const method = (request.method ?? 'GET').toUpperCase();

  const init: NodeRequestInit = {
    method,
    headers: buildUpstreamHeaders(request.headers),
    redirect: 'manual',
    signal: abortController.signal,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    const contentType = request.headers['content-type'] ?? '';
    const isJsonRequest = typeof contentType === 'string' && contentType.includes('application/json');

    if (isJsonRequest) {
      let rawBody: string;
      try {
        rawBody = await readRequestBodyText(request, 10 * 1024 * 1024);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body';
        sendJson(response, 400, {
          error: {
            message,
            type: 'invalid_request_error',
          },
        });
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : {};
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid JSON body';
        sendJson(response, 400, {
          error: {
            message,
            type: 'invalid_request_error',
          },
        });
        return;
      }

      if (!isRecord(parsedBody)) {
        sendJson(response, 400, {
          error: {
            message: 'JSON body must be an object',
            type: 'invalid_request_error',
          },
        });
        return;
      }

      const auditSplit = splitAuditConfig(parsedBody);
      writeAdapterLog({
        id: requestId,
        stage: 'audit',
        required: auditSplit.audit !== null,
        ...(auditSplit.error ? { error: auditSplit.error } : {}),
      });
      if (auditSplit.error) {
        sendJson(response, 400, {
          error: {
            message: auditSplit.error,
            type: 'invalid_request_error',
          },
        });
        return;
      }

      if (auditSplit.audit) {
        const auditInputs = extractAuditInputs(auditSplit.sanitizedPayload);
        if (!auditInputs.ok) {
          sendJson(response, 400, {
            error: {
              message: auditInputs.error,
              type: 'invalid_request_error',
            },
          });
          return;
        }

        try {
          const auditResult = await runAudit(auditSplit.audit, auditInputs.inputs, abortController.signal);
          if (!auditResult.ok) {
            if (Array.isArray(auditResult.failures) && auditResult.failures.length > 0) {
              sendJson(response, 403, {
                error: {
                  message: buildAuditFailureMessage(auditResult.failures),
                  type: 'content_audit_failed',
                  failures: auditResult.failures,
                },
              });
              return;
            }

            sendJson(response, 502, {
              error: {
                message: auditResult.error,
                type: 'audit_upstream_error',
              },
            });
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown audit error';
          sendJson(response, 502, {
            error: {
              message: `Audit request failed: ${message}`,
              type: 'audit_upstream_error',
            },
          });
          return;
        }
      }

      init.body = JSON.stringify(auditSplit.sanitizedPayload);
    } else {
      writeAdapterLog({ id: requestId, stage: 'audit', required: false, reason: 'non_json' });
      init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
      init.duplex = 'half';
    }
  }

  try {
    writeAdapterLog({ id: requestId, stage: 'upstream', url: targetUrl.toString() });
    const upstreamResponse = await fetch(targetUrl, init);
    await relayUpstreamResponse(upstreamResponse, response, runtime, adapterMethod);
  } catch (error) {
    if (abortController.signal.aborted) {
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown upstream error';
    sendJson(response, 502, {
      error: {
        message: `Upstream request failed: ${message}`,
        type: 'upstream_error',
      },
    });
  }
}

function checkAuthorization(
  request: IncomingMessage,
  runtime: RuntimeConfig,
): { ok: true } | { ok: false; reason: string } {
  const headerValue = request.headers['adapter-authorization'];
  if (headerValue === undefined) {
    return { ok: false, reason: 'missing' };
  }

  if (typeof headerValue !== 'string') {
    return { ok: false, reason: 'invalid_type' };
  }

  if (headerValue.trim() !== runtime.adapterAuthorization) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true };
}

function stripUrlQueryAndHash(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid UPSTREAM-BASE-URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('UPSTREAM-BASE-URL must be an http(s) URL');
  }

  if (parsed.username || parsed.password) {
    throw new Error('UPSTREAM-BASE-URL must not include credentials');
  }

  if (parsed.search || parsed.hash) {
    throw new Error('UPSTREAM-BASE-URL must not include query or hash');
  }

  return parsed.toString();
}

async function readRequestBodyText(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`Request body too large (>${maxBytes} bytes)`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, total).toString('utf8');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRequestSource(request: IncomingMessage): {
  method: string;
  url: string;
  remoteAddress: string | null;
  forwardedFor: string | null;
  userAgent: string | null;
} {
  const forwardedForHeader = request.headers['x-forwarded-for'];
  return {
    method: (request.method ?? 'GET').toUpperCase(),
    url: request.url ?? '/',
    remoteAddress: request.socket?.remoteAddress ?? null,
    forwardedFor: typeof forwardedForHeader === 'string' ? forwardedForHeader : null,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

function writeAdapterLog(event: unknown): void {
  try {
    process.stdout.write(`[adapter] ${JSON.stringify(event)}\n`);
  } catch {
    // ignore logging failures
  }
}

function buildAuditFailureMessage(failures: AuditThresholdFailure[]): string {
  const details = failures
    .map((failure) => {
      return `category=${failure.category} maxScore=${failure.maxScore} score=${failure.score}`;
    })
    .join('; ');

  return details ? `Content audit failed: ${details}` : 'Content audit failed';
}
