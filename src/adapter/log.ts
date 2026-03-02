export interface LogWriteOptions {
  redactRaw?: boolean;
  env?: NodeJS.ProcessEnv;
}

const REDACTED = '[REDACTED]';

export function isAuditRawRedactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUDIT_REDACT_RAW === '1';
}

export function writeTaggedLog(namespace: string, event: unknown, options: LogWriteOptions = {}): void {
  const line = buildTaggedLogLine(namespace, event, options);
  try {
    process.stdout.write(line);
  } catch {
    // ignore logging failures
  }
}

export function buildTaggedLogLine(namespace: string, event: unknown, options: LogWriteOptions = {}): string {
  const redactRaw = options.redactRaw ?? isAuditRawRedactionEnabled(options.env);
  const payload = redactRaw ? redactRawField(event) : event;
  return `[${namespace}] ${JSON.stringify(payload)}\n`;
}

function redactRawField(event: unknown): unknown {
  if (event === null || typeof event !== 'object') {
    return event;
  }

  if (!Object.prototype.hasOwnProperty.call(event, 'raw')) {
    return event;
  }

  const record = event as Record<string, unknown>;
  const raw = record.raw;
  return {
    ...record,
    raw: typeof raw === 'string' ? `${REDACTED} ${raw.length} chars` : REDACTED,
  };
}
