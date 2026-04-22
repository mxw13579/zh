import type { IncomingHttpHeaders } from 'node:http';

import type { RuntimeConfig } from '../config.js';

export interface ResponseTransform<TransformContext = unknown> {
  name: string;
  transformJsonResponse(
    payload: unknown,
    runtime: RuntimeConfig,
    context: TransformContext | null,
  ): unknown;
  createStreamTransformer(
    runtime: RuntimeConfig,
    context: TransformContext | null,
  ): TransformStream<Uint8Array, Uint8Array>;
}

export interface ProtocolHandler<ParsedRequest = unknown, TransformContext = unknown> {
  name: 'openai' | 'claude';
  parseRequest(body: unknown, headers: IncomingHttpHeaders): ParsedRequest;
  resolveResponseTransform(
    methodName: string | null,
  ): { ok: true; value: ResponseTransform<TransformContext> | null } | { ok: false; error: string };
  extractAuditInputs(
    parsed: ParsedRequest,
  ): { ok: true; inputs: string[] } | { ok: false; error: string };
  enforceRequestPolicy(
    parsed: ParsedRequest,
    controls: GatewayControls,
  ): { ok: true; value: ParsedRequest; transformContext: TransformContext | null } | { ok: false; error: string };
  buildUpstreamRequest(args: {
    parsed: ParsedRequest;
    requestUrl: string | undefined;
    upstreamBaseUrl: string;
    incomingHeaders: IncomingHttpHeaders;
  }): { url: URL; headers: Headers; body: BodyInit | null };
}

export interface AuditControlInput {
  baseUrl: string;
  token: string;
  categories: string[];
}

export interface GatewayControls {
  adapterMethodName: string | null;
  safetyParametersEnabled: boolean;
  promptTokensMax: number | null;
  audit: AuditControlInput | null;
}

export type RouteTarget =
  | { kind: 'openai'; requestPath: string }
  | { kind: 'claude'; requestPath: string };

