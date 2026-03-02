import type { IncomingMessage } from 'node:http';

import type { RuntimeConfig } from './config.js';
import { checkAdapterAuthorization } from './utils/auth.js';

export function checkAuthorization(
  request: IncomingMessage,
  runtime: RuntimeConfig,
): { ok: true } | { ok: false; reason: string } {
  return checkAdapterAuthorization(request.headers['adapter-authorization'], runtime.adapterAuthorization);
}
