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
import { sendError } from './respond.js';
import { countPromptTokens, parsePromptTokensMax } from './tokens.js';
import { isRecord } from './utils/json.js';
import type { UsagePatchContext } from './usage.js';

type NodeRequestInit = RequestInit & { duplex?: 'half' };

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
    sendError(response, 401, 'Unauthorized', 'unauthorized');
    return;
  }

  const upstreamBaseUrlHeader = request.headers['upstream-base-url'];
  if (typeof upstreamBaseUrlHeader !== 'string' || !upstreamBaseUrlHeader.trim()) {
    sendError(response, 400, 'Missing required header: UPSTREAM-BASE-URL', 'invalid_request_error');
    return;
  }

  const adapterMethodHeader = request.headers['adapter-method'];
  let adapterMethod: AdapterMethod | null = null;
  if (adapterMethodHeader !== undefined) {
    if (typeof adapterMethodHeader !== 'string') {
      sendError(response, 400, 'Invalid Adapter-Method header', 'invalid_request_error');
      return;
    }

    const methodName = adapterMethodHeader.trim();
    if (methodName) {
      adapterMethod = getAdapterMethod(methodName);
      if (!adapterMethod) {
        sendError(response, 400, 'Unknown adapter-method', 'invalid_request_error');
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
    sendError(response, 400, message, 'invalid_request_error');
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

  let usagePatch: UsagePatchContext | null = null;

  if (method !== 'GET' && method !== 'HEAD') {
    const contentType = request.headers['content-type'] ?? '';
    const isJsonRequest = typeof contentType === 'string' && contentType.includes('application/json');

    if (isJsonRequest) {
      let rawBody: string;
      try {
        rawBody = await readRequestBodyText(request, 10 * 1024 * 1024);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body';
        sendError(response, 400, message, 'invalid_request_error');
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : {};
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid JSON body';
        sendError(response, 400, message, 'invalid_request_error');
        return;
      }

      if (!isRecord(parsedBody)) {
        sendError(response, 400, 'JSON body must be an object', 'invalid_request_error');
        return;
      }

      const safetyParametersHeader = request.headers['safety-parameters'];
      const safetyParametersEnabled =
        typeof safetyParametersHeader === 'string' &&
        safetyParametersHeader.trim().toLowerCase() === 'true';

      const promptTokensMaxHeader = request.headers['prompt-tokens-max'];
      let promptTokensMax: number | null = null;
      if (promptTokensMaxHeader !== undefined) {
        if (typeof promptTokensMaxHeader !== 'string') {
          sendError(response, 400, 'Invalid Prompt-Tokens-Max header', 'invalid_request_error');
          return;
        }

        const parsed = parsePromptTokensMax(promptTokensMaxHeader);
        if (!parsed.ok) {
          sendError(response, 400, parsed.error, 'invalid_request_error');
          return;
        }
        promptTokensMax = parsed.value;
      }

      const auditSplit = splitAuditConfig(parsedBody);
      writeAdapterLog({
        id: requestId,
        stage: 'audit',
        required: auditSplit.audit !== null,
        ...(auditSplit.error ? { error: auditSplit.error } : {}),
      });
      if (auditSplit.error) {
        sendError(response, 400, auditSplit.error, 'invalid_request_error');
        return;
      }

      const model = typeof auditSplit.sanitizedPayload.model === 'string' ? auditSplit.sanitizedPayload.model : null;
      const wantsStream = auditSplit.sanitizedPayload.stream === true;
      const shouldCountTokens = promptTokensMax !== null || (adapterMethod !== null && wantsStream);

      let promptTokens: number | null = null;
      if (shouldCountTokens) {
        const counted = countPromptTokens(auditSplit.sanitizedPayload.messages, model);
        if (!counted.ok) {
          sendError(response, 400, counted.error, 'invalid_request_error');
          return;
        }

        promptTokens = counted.value;
        if (promptTokensMax !== null && promptTokens > promptTokensMax) {
          sendError(
            response,
            400,
            `Prompt tokens exceed limit (max=${promptTokensMax} current=${promptTokens})`,
            'invalid_request_error',
          );
          return;
        }

        if (adapterMethod !== null && wantsStream) {
          usagePatch = { promptTokens, model };
        }
      }

      if (auditSplit.audit) {
        const auditInputs = extractAuditInputs(auditSplit.sanitizedPayload);
        if (!auditInputs.ok) {
          sendError(response, 400, auditInputs.error, 'invalid_request_error');
          return;
        }

        try {
          const auditResult = await runAudit(auditSplit.audit, auditInputs.inputs, abortController.signal);
          if (!auditResult.ok) {
            if (Array.isArray(auditResult.failures) && auditResult.failures.length > 0) {
              sendError(
                response,
                403,
                buildAuditFailureMessage(auditResult.failures),
                'content_audit_failed',
                { failures: auditResult.failures },
              );
              return;
            }

            sendError(response, 502, auditResult.error, 'audit_upstream_error');
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown audit error';
          sendError(response, 502, `Audit request failed: ${message}`, 'audit_upstream_error');
          return;
        }
      }

      if (safetyParametersEnabled) {
        delete auditSplit.sanitizedPayload.presence_penalty;
        delete auditSplit.sanitizedPayload.frequency_penalty;
        delete auditSplit.sanitizedPayload.top_p;
      }

      init.body = JSON.stringify(auditSplit.sanitizedPayload);
    } else {
      const promptTokensMaxHeader = request.headers['prompt-tokens-max'];
      if (promptTokensMaxHeader !== undefined) {
        sendError(
          response,
          400,
          'Prompt-Tokens-Max requires an application/json request with a messages array',
          'invalid_request_error',
        );
        return;
      }

      writeAdapterLog({ id: requestId, stage: 'audit', required: false, reason: 'non_json' });
      init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
      init.duplex = 'half';
    }
  }

  try {
    writeAdapterLog({ id: requestId, stage: 'upstream', url: targetUrl.toString() });
    const upstreamResponse = await fetch(targetUrl, init);
    await relayUpstreamResponse(upstreamResponse, response, runtime, adapterMethod, usagePatch);
  } catch (error) {
    if (abortController.signal.aborted) {
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown upstream error';
    sendError(response, 502, `Upstream request failed: ${message}`, 'upstream_error');
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
