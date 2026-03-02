import { randomUUID } from 'node:crypto';

import { normalizeBaseUrl } from './config.js';
import type { JsonRecord } from './normalize.js';

export interface AuditThresholdFailure {
  category: string;
  maxScore: number;
  score: number;
  inputIndex: number;
}

export interface AuditConfig {
  baseUrl: string;
  token: string;
  thresholds: Map<string, number>;
}

export type AuditDecision =
  | { allowed: true; sanitizedPayload: JsonRecord }
  | { allowed: false; sanitizedPayload: JsonRecord; failures: AuditThresholdFailure[] };

export function splitAuditConfig(payload: JsonRecord): {
  audit: AuditConfig | null;
  sanitizedPayload: JsonRecord;
  error?: string;
} {
  const rawAuditBaseUrl = payload.audit_base_url;
  const rawAuditToken = payload.audit_token;
  const rawAuditCategories = payload.audit_categories;

  const wantsAudit =
    rawAuditBaseUrl !== undefined || rawAuditToken !== undefined || rawAuditCategories !== undefined;
  if (!wantsAudit) {
    return { audit: null, sanitizedPayload: payload };
  }

  const auditBaseUrl = stringField(rawAuditBaseUrl);
  const auditToken = stringField(rawAuditToken);
  const auditCategories = rawAuditCategories;

  if (!auditBaseUrl || !auditToken || auditCategories === undefined) {
    return {
      audit: null,
      sanitizedPayload: payload,
      error: 'audit_base_url, audit_token, audit_categories are required when audit is enabled',
    };
  }

  const thresholds = parseAuditCategories(auditCategories);
  if (!thresholds.ok) {
    return { audit: null, sanitizedPayload: payload, error: thresholds.error };
  }

  const sanitizedPayload: JsonRecord = { ...payload };
  delete sanitizedPayload.audit_base_url;
  delete sanitizedPayload.audit_token;
  delete sanitizedPayload.audit_categories;

  return {
    audit: {
      baseUrl: auditBaseUrl,
      token: auditToken,
      thresholds: thresholds.value,
    },
    sanitizedPayload,
  };
}

export async function runAudit(
  audit: AuditConfig,
  inputs: string[],
  signal: AbortSignal,
): Promise<
  | { ok: true }
  | { ok: false; error: string; failures?: AuditThresholdFailure[] }
> {
  const auditRequestId = randomUUID();
  const auditBaseUrl = parseHttpBaseUrl(audit.baseUrl);
  if (!auditBaseUrl.ok) {
    return { ok: false, error: auditBaseUrl.error };
  }

  // Be tolerant to callers passing base URLs that already include a `/v1` path segment.
  // e.g. `https://api.openai.com/v1` -> `.../v1/moderations` (not `.../v1/v1/moderations`).
  const base = new URL(auditBaseUrl.value);
  const path = base.pathname.endsWith('/v1/') ? 'moderations' : 'v1/moderations';
  const url = new URL(path, base);
  writeAuditLog({
    id: auditRequestId,
    stage: 'request',
    url: url.toString(),
    thresholds: Object.fromEntries(audit.thresholds.entries()),
    inputsCount: inputs.length,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${audit.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ input: inputs.length === 1 ? inputs[0] : inputs }),
    signal,
  });

  const responseText = await safeText(response);
  writeAuditLog({
    id: auditRequestId,
    stage: 'response',
    status: response.status,
    ok: response.ok,
    raw: truncateForLog(responseText, 16_384),
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `Audit upstream error (${response.status}): ${responseText || response.statusText}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, error: `Audit upstream returned non-JSON response: ${message}` };
  }

  const failures = evaluateThresholds(parsed, audit.thresholds);
  if (failures === null) {
    writeAuditLog({
      id: auditRequestId,
      stage: 'decision',
      allowed: false,
      error: 'missing results[].category_scores',
    });
    return { ok: false, error: 'Audit upstream response missing results[].category_scores' };
  }

  writeAuditLog({
    id: auditRequestId,
    stage: 'decision',
    allowed: failures.length === 0,
    failures,
  });

  return failures.length > 0 ? { ok: false, error: 'Content audit failed', failures } : { ok: true };
}

export function extractAuditInputs(payload: JsonRecord): { ok: true; inputs: string[] } | { ok: false; error: string } {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return { ok: false, error: 'audit requires request body field: messages (array)' };
  }

  const lastUser = findLastMessage(messages, 'user');
  if (!lastUser) {
    return { ok: false, error: 'audit requires at least one user message' };
  }

  const lastAssistant = findPreviousMessage(messages, lastUser.index - 1, 'assistant');

  const inputs: string[] = [];
  if (lastAssistant?.text) {
    inputs.push(lastAssistant.text);
  }
  if (lastUser.text) {
    inputs.push(lastUser.text);
  }

  if (inputs.length === 0) {
    return { ok: false, error: 'audit requires textual content in the last user/assistant messages' };
  }

  return { ok: true, inputs };
}

function findLastMessage(
  messages: unknown[],
  role: 'user' | 'assistant',
): { index: number; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!isRecord(msg)) {
      continue;
    }

    const msgRole = msg.role;
    if (msgRole === 'system') {
      continue;
    }

    if (msgRole === role) {
      return { index: i, text: extractTextContent(msg.content).trim() };
    }
  }

  return null;
}

function findPreviousMessage(
  messages: unknown[],
  startIndex: number,
  role: 'user' | 'assistant',
): { index: number; text: string } | null {
  for (let i = startIndex; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!isRecord(msg)) {
      continue;
    }

    const msgRole = msg.role;
    if (msgRole === 'system') {
      continue;
    }

    if (msgRole === role) {
      return { index: i, text: extractTextContent(msg.content).trim() };
    }
  }

  return null;
}

function parseAuditCategories(
  raw: unknown,
): { ok: true; value: Map<string, number> } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'audit_categories must be an array like ["violence/graphic:0.9"]' };
  }

  const thresholds = new Map<string, number>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'audit_categories items must be strings like "violence/graphic:0.9"' };
    }

    const value = item.trim();
    const sep = value.lastIndexOf(':');
    if (sep <= 0 || sep === value.length - 1) {
      return { ok: false, error: `Invalid audit_categories entry: ${item}` };
    }

    const category = value.slice(0, sep).trim();
    const maxScore = Number(value.slice(sep + 1).trim());

    if (!category) {
      return { ok: false, error: `Invalid audit_categories entry: ${item}` };
    }
    if (!Number.isFinite(maxScore)) {
      return { ok: false, error: `Invalid audit_categories threshold: ${item}` };
    }
    if (maxScore < 0 || maxScore > 1) {
      return { ok: false, error: `audit_categories threshold must be within [0,1]: ${item}` };
    }

    thresholds.set(category, maxScore);
  }

  if (thresholds.size === 0) {
    return { ok: false, error: 'audit_categories must not be empty when audit is enabled' };
  }

  return { ok: true, value: thresholds };
}

function parseHttpBaseUrl(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'audit_base_url must be a valid http(s) URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'audit_base_url must be an http(s) URL' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'audit_base_url must not include credentials' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'audit_base_url must not include query or hash' };
  }

  return { ok: true, value: normalizeBaseUrl(parsed.toString()) };
}

function evaluateThresholds(
  response: unknown,
  thresholds: Map<string, number>,
): AuditThresholdFailure[] | null {
  if (!isRecord(response) || !Array.isArray(response.results)) {
    return null;
  }

  const failures: AuditThresholdFailure[] = [];

  for (let i = 0; i < response.results.length; i += 1) {
    const result = response.results[i];
    if (!isRecord(result) || !isRecord(result.category_scores)) {
      return null;
    }

    const scores = result.category_scores;
    for (const [category, maxScore] of thresholds.entries()) {
      const scoreValue = scores[category];
      if (typeof scoreValue !== 'number' || !Number.isFinite(scoreValue)) {
        return null;
      }

      if (scoreValue > maxScore) {
        failures.push({ category, maxScore, score: scoreValue, inputIndex: i });
      }
    }
  }

  return failures;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function writeAuditLog(event: unknown): void {
  try {
    process.stdout.write(`[audit] ${JSON.stringify(event)}\n`);
  } catch {
    // ignore logging failures
  }
}

function truncateForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }

      if (!isRecord(item)) {
        continue;
      }

      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
        continue;
      }

      if (typeof item.text === 'string') {
        parts.push(item.text);
        continue;
      }
    }
    return parts.join('');
  }

  return '';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
