import type { ServerResponse } from 'node:http';

export function setCorsHeaders(response: ServerResponse, allowOrigin: string): void {
  response.setHeader('access-control-allow-origin', allowOrigin);
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader('access-control-allow-headers', 'Authorization,Content-Type');
}

