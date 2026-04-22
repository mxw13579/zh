import { claudeProtocol } from './claude.js';
import { openAiProtocol } from './openai.js';
import type { ProtocolHandler, RouteTarget } from './types.js';

export function resolveRouteTarget(requestUrl: string | undefined): RouteTarget {
  const parsed = new URL(requestUrl ?? '/', 'http://localhost');
  const pathname = parsed.pathname;

  if (pathname === '/v1/messages') {
    return { kind: 'claude', requestPath: pathname };
  }

  return { kind: 'openai', requestPath: pathname };
}

export function getProtocolHandler(target: RouteTarget): ProtocolHandler {
  return target.kind === 'claude' ? claudeProtocol : openAiProtocol;
}

