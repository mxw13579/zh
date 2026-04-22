import type { IncomingHttpHeaders } from 'node:http';

import { type GatewayControls, type ProtocolHandler } from './types.js';
import { voidAdapter1Transform } from './openai-response-transform.js';
import { buildUpstreamHeaders } from '../headers.js';
import { countPromptTokens } from '../tokens.js';
import type { UsagePatchContext } from '../usage.js';
import {
  UPSTREAM_BASE_URL_ERROR_MESSAGES,
  joinBaseUrlWithV1Endpoint,
  parseHttpBaseUrlOrThrow,
} from '../utils/url.js';
import { isRecord, type JsonRecord } from '../utils/json.js';
import { extractAuditInputs as extractOpenAiAuditInputs } from '../audit.js';

export const openAiProtocol: ProtocolHandler<JsonRecord, UsagePatchContext> = {
  name: 'openai',
  parseRequest(body: unknown): JsonRecord {
    if (!isRecord(body)) {
      throw new Error('JSON body must be an object');
    }
    return { ...body };
  },
  resolveResponseTransform(methodName) {
    if (!methodName) {
      return { ok: true, value: null };
    }
    if (methodName === voidAdapter1Transform.name) {
      return { ok: true, value: voidAdapter1Transform };
    }
    return { ok: false, error: 'Unknown adapter-method' };
  },
  extractAuditInputs(parsed) {
    return extractOpenAiAuditInputs(parsed);
  },
  enforceRequestPolicy(parsed, controls) {
    const next: JsonRecord = { ...parsed };

    if (controls.safetyParametersEnabled) {
      delete next.presence_penalty;
      delete next.frequency_penalty;
      delete next.top_p;
    }

    const model = typeof next.model === 'string' ? next.model : null;
    const wantsStream = next.stream === true;
    const shouldCountTokens = controls.promptTokensMax !== null || (controls.adapterMethodName !== null && wantsStream);

    let usagePatch: UsagePatchContext | null = null;
    if (shouldCountTokens) {
      const counted = countPromptTokens(next.messages, model);
      if (!counted.ok) {
        return { ok: false, error: counted.error };
      }

      if (controls.promptTokensMax !== null && counted.value > controls.promptTokensMax) {
        return {
          ok: false,
          error: `Prompt tokens exceed limit (max=${controls.promptTokensMax} current=${counted.value})`,
        };
      }

      if (controls.adapterMethodName !== null && wantsStream) {
        usagePatch = { promptTokens: counted.value, model };
      }
    }

    return { ok: true, value: next, transformContext: usagePatch };
  },
  buildUpstreamRequest(args) {
    const parsedRequestUrl = new URL(args.requestUrl ?? '/', 'http://localhost');
    const upstreamBaseUrl = parseHttpBaseUrlOrThrow(args.upstreamBaseUrl, UPSTREAM_BASE_URL_ERROR_MESSAGES);
    const url = joinBaseUrlWithV1Endpoint(upstreamBaseUrl, 'chat/completions');
    url.search = parsedRequestUrl.search;

    return {
      url,
      headers: buildUpstreamHeaders(args.incomingHeaders),
      body: JSON.stringify(args.parsed),
    };
  },
};

