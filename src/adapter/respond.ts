import type { ServerResponse } from 'node:http';

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

export function sendError(
  response: ServerResponse,
  statusCode: number,
  message: string,
  type: string,
  extra: Record<string, unknown> | undefined = undefined,
): void {
  const error: Record<string, unknown> = { message, type };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (key === 'message' || key === 'type') {
        continue;
      }
      error[key] = value;
    }
  }

  sendJson(response, statusCode, { error });
}
