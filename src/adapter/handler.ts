import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { runAudit, splitAuditConfig, type AuditThresholdFailure } from './audit.js';
import { type RuntimeConfig } from './config.js';
import { setCorsHeaders } from './cors.js';
import { buildUpstreamHeaders } from './headers.js';
import { readRequiredUpstreamBaseUrl, readAdapterMethodName, resolveRouteTarget } from './ingress.js';
import { writeTaggedLog } from './log.js';
import { checkAuthorization } from './policy.js';
import { getProtocolHandler } from './protocols/index.js';
import type { GatewayControls } from './protocols/types.js';
import { relayUpstreamResponse } from './relay.js';
import { sendError } from './respond.js';
import { parsePromptTokensMax } from './tokens.js';
import { isRecord } from './utils/json.js';
import {
  joinBaseUrlWithV1Endpoint,
  parseHttpBaseUrlOrThrow,
  UPSTREAM_BASE_URL_ERROR_MESSAGES,
} from './utils/url.js';

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

  const upstreamBaseUrl = readRequiredUpstreamBaseUrl(request.headers);
  if (!upstreamBaseUrl.ok) {
    sendError(response, 400, 'Missing required header: UPSTREAM-BASE-URL', 'invalid_request_error');
    return;
  }

  const routeTarget = resolveRouteTarget(request.url);
  const protocol = getProtocolHandler(routeTarget);

  const adapterMethodResult = readAdapterMethodName(request.headers);
  if (!adapterMethodResult.ok) {
    sendError(response, 400, adapterMethodResult.error, 'invalid_request_error');
    return;
  }
  const adapterMethodName = adapterMethodResult.value;

  const responseTransformResult = protocol.resolveResponseTransform(adapterMethodName);
  if (!responseTransformResult.ok) {
    sendError(response, 400, responseTransformResult.error, 'invalid_request_error');
    return;
  }
  const responseTransform = responseTransformResult.value;

  const abortController = new AbortController();
  const abortUpstream = (): void => abortController.abort();

  response.on('close', abortUpstream);
  response.on('finish', () => response.off('close', abortUpstream));

  const method = (request.method ?? 'GET').toUpperCase();

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
      const safetyParametersProvided = safetyParametersHeader !== undefined;
      if (routeTarget.kind === 'claude' && safetyParametersProvided) {
        sendError(response, 400, 'Safety-Parameters is not supported for Claude routes', 'invalid_request_error');
        return;
      }
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

      const auditSplit = splitAuditConfig(parsedBody, request.headers);
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

      let parsedRequest: unknown;
      try {
        parsedRequest = protocol.parseRequest(auditSplit.sanitizedPayload, request.headers);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body';
        sendError(response, 400, message, 'invalid_request_error');
        return;
      }

      const controls: GatewayControls = {
        adapterMethodName,
        safetyParametersEnabled,
        promptTokensMax,
        audit:
          auditSplit.audit === null
            ? null
            : {
                baseUrl: auditSplit.audit.baseUrl,
                token: auditSplit.audit.token,
                categories: Array.from(auditSplit.audit.thresholds.entries()).map(
                  ([category, threshold]) => `${category}:${threshold}`,
                ),
              },
      };

      const enforced = protocol.enforceRequestPolicy(parsedRequest, controls);
      if (!enforced.ok) {
        sendError(response, 400, enforced.error, 'invalid_request_error');
        return;
      }

      if (auditSplit.audit) {
        const auditInputs = protocol.extractAuditInputs(enforced.value);
        const skipAuditForNoExtractableText =
          protocol.name === 'openai' &&
          auditInputs.ok === false &&
          typeof auditInputs.error === 'string' &&
          auditInputs.error === 'audit requires textual content in the last user/assistant messages';

        if (!auditInputs.ok && !skipAuditForNoExtractableText) {
          sendError(response, 400, auditInputs.error, 'invalid_request_error');
          return;
        }

        if (auditInputs.ok && auditInputs.inputs.length > 0) {
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
      }

      let upstreamRequest;
      try {
        upstreamRequest = protocol.buildUpstreamRequest({
          parsed: enforced.value,
          requestUrl: request.url,
          upstreamBaseUrl: upstreamBaseUrl.value,
          incomingHeaders: request.headers,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid UPSTREAM-BASE-URL';
        sendError(response, 400, message, 'invalid_request_error');
        return;
      }

      const init: NodeRequestInit = {
        method,
        headers: upstreamRequest.headers,
        body: upstreamRequest.body,
        redirect: 'manual',
        signal: abortController.signal,
      };

      try {
        writeAdapterLog({ id: requestId, stage: 'upstream', url: upstreamRequest.url.toString() });
        const upstreamResponse = await fetch(upstreamRequest.url, init);
        await relayUpstreamResponse(upstreamResponse, response, runtime, responseTransform, enforced.transformContext);
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        const message = error instanceof Error ? error.message : 'Unknown upstream error';
        sendError(response, 502, `Upstream request failed: ${message}`, 'upstream_error');
      }
      return;
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

      const safetyParametersHeader = request.headers['safety-parameters'];
      const safetyParametersProvided = safetyParametersHeader !== undefined;
      if (routeTarget.kind === 'claude' && safetyParametersProvided) {
        sendError(response, 400, 'Safety-Parameters is not supported for Claude routes', 'invalid_request_error');
        return;
      }

      writeAdapterLog({ id: requestId, stage: 'audit', required: false, reason: 'non_json' });

      let targetUrl: URL;
      try {
        const normalizedBaseUrl = parseHttpBaseUrlOrThrow(upstreamBaseUrl.value, UPSTREAM_BASE_URL_ERROR_MESSAGES);
        targetUrl = routeTarget.kind === 'claude'
          ? joinBaseUrlWithV1Endpoint(normalizedBaseUrl, 'messages')
          : joinBaseUrlWithV1Endpoint(normalizedBaseUrl, 'chat/completions');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid UPSTREAM-BASE-URL';
        sendError(response, 400, message, 'invalid_request_error');
        return;
      }
      targetUrl.search = new URL(request.url ?? '/', 'http://localhost').search;

      const init: NodeRequestInit = {
        method,
        headers: buildUpstreamHeaders(request.headers),
        body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
        redirect: 'manual',
        signal: abortController.signal,
        duplex: 'half',
      };

      try {
        writeAdapterLog({ id: requestId, stage: 'upstream', url: targetUrl.toString() });
        const upstreamResponse = await fetch(targetUrl, init);
        await relayUpstreamResponse(upstreamResponse, response, runtime, responseTransform, null);
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        const message = error instanceof Error ? error.message : 'Unknown upstream error';
        sendError(response, 502, `Upstream request failed: ${message}`, 'upstream_error');
      }
      return;
    }
  }

  sendError(response, 405, 'Method not allowed', 'invalid_request_error');
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
  writeTaggedLog('adapter', event);
}

function buildAuditFailureMessage(failures: AuditThresholdFailure[]): string {
  const details = failures
    .map((failure) => {
      return `category=${failure.category} maxScore=${failure.maxScore} score=${failure.score}`;
    })
    .join('; ');

  return details ? `Content audit failed: ${details}` : 'Content audit failed';
}
