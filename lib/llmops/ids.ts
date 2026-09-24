import { randomUUID, randomBytes, createHash } from 'node:crypto';

/**
 * Generate a new UUID v4 trace identifier.
 */
export function newTraceId(): string {
  return randomUUID();
}

/**
 * Generate a new UUID v4 run identifier.
 */
export function newRunId(): string {
  return randomUUID();
}

/**
 * Generate a new 16-character hexadecimal span identifier (64-bit).
 */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Generate a 12-character SHA-256 hash prefix from any input value.
 * Used for pseudonymizing user IDs and stable hash references.
 */
export function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
