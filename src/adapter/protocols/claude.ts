import type { IncomingHttpHeaders } from 'node:http';

import { type GatewayControls, type ProtocolHandler } from './types.js';
import { buildUpstreamHeaders } from '../headers.js';
import {
  UPSTREAM_BASE_URL_ERROR_MESSAGES,
  joinBaseUrlWithV1Endpoint,
  parseHttpBaseUrlOrThrow,
} from '../utils/url.js';
import { extractTextContent } from '../utils/content.js';
import { isRecord, type JsonRecord } from '../utils/json.js';

export const claudeProtocol: ProtocolHandler<JsonRecord, never> = {
  name: 'claude',
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
    return { ok: false, error: 'Adapter-Method is not supported for Claude routes' };
  },
  extractAuditInputs(parsed) {
    const inputs: string[] = [];

    const system = parsed.system;
    const systemText = extractTextContent(system).trim();
    if (systemText) {
      inputs.push(systemText);
    }

    const messages = parsed.messages;
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (!isRecord(message)) {
          continue;
        }
        const text = extractTextContent(message.content).trim();
        if (text) {
          inputs.push(text);
        }
      }
    }

    return { ok: true, inputs };
  },
  enforceRequestPolicy(parsed, controls) {
    if (controls.promptTokensMax !== null) {
      return { ok: false, error: 'Prompt-Tokens-Max is not supported for Claude routes' };
    }
    if (controls.safetyParametersEnabled) {
      return { ok: false, error: 'Safety-Parameters is not supported for Claude routes' };
    }
    return { ok: true, value: { ...parsed }, transformContext: null };
  },
  buildUpstreamRequest(args) {
    const parsedRequestUrl = new URL(args.requestUrl ?? '/', 'http://localhost');
    const upstreamBaseUrl = parseHttpBaseUrlOrThrow(args.upstreamBaseUrl, UPSTREAM_BASE_URL_ERROR_MESSAGES);
    const url = joinBaseUrlWithV1Endpoint(upstreamBaseUrl, 'messages');
    url.search = parsedRequestUrl.search;

    return {
      url,
      headers: buildUpstreamHeaders(args.incomingHeaders),
      body: JSON.stringify(args.parsed),
    };
  },
};
