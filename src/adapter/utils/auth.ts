import { timingSafeEqual } from 'node:crypto';

export type AuthorizationCheck =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'invalid_type' | 'mismatch' };

export function checkAdapterAuthorization(
  headerValue: unknown,
  expectedAuthorization: string,
): AuthorizationCheck {
  if (headerValue === undefined) {
    return { ok: false, reason: 'missing' };
  }

  if (typeof headerValue !== 'string') {
    return { ok: false, reason: 'invalid_type' };
  }

  const normalized = headerValue.trim();
  if (!constantTimeEqual(normalized, expectedAuthorization)) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true };
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  const maxLength = Math.max(leftBuffer.length, rightBuffer.length);

  const paddedLeft = Buffer.alloc(maxLength);
  const paddedRight = Buffer.alloc(maxLength);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);

  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}
