/**
 * PII and Secret Redaction Utilities (Spec L3.1 & L10)
 * Redacts Egyptian National IDs, Egyptian phone numbers, emails, and bearer tokens.
 */

// 14-digit Egyptian National ID
const NATIONAL_ID_REGEX = /(?<!\d)\d{14}(?!\d)/g;

// Egyptian phone numbers: 010, 011, 012, 015 with optional +20/0020 prefix and optional spacing/dashes
const EGYPT_PHONE_REGEX = /(?<!\d)(?:\+?20[\s\-]?)?0?1[0125][\s\-]?\d{4}[\s\-]?\d{4}(?!\d)/g;

// Email addresses
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Bearer tokens and common API secret tokens
const BEARER_TOKEN_REGEX = /\bBearer\s+[A-Za-z0-9_\-.]+\b/gi;
const GENERIC_API_TOKEN_REGEX = /\b(?:sk|ghp|gho|glpat|xoxb|xoxp)-[A-Za-z0-9_\-]{16,}\b/gi;
const JWT_TOKEN_REGEX = /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g;

// Sensitive object key patterns
const SENSITIVE_KEY_TOKEN = /^(?:password|token|secret|authorization|cookie|apiKey|api_key|access_token|refresh_token)$/i;
const SENSITIVE_KEY_NATIONAL_ID = /^national_?id$/i;
const SENSITIVE_KEY_PHONE = /^phone(?:_number)?$/i;
const SENSITIVE_KEY_EMAIL = /^email$/i;

/**
 * Redact sensitive PII and tokens from a string.
 */
export function redactValue(s: string): string {
  if (typeof s !== 'string' || !s) {
    return s;
  }

  return s
    .replace(BEARER_TOKEN_REGEX, '[REDACTED:TOKEN]')
    .replace(GENERIC_API_TOKEN_REGEX, '[REDACTED:TOKEN]')
    .replace(JWT_TOKEN_REGEX, '[REDACTED:TOKEN]')
    .replace(NATIONAL_ID_REGEX, '[REDACTED:NATIONAL_ID]')
    .replace(EGYPT_PHONE_REGEX, '[REDACTED:PHONE]')
    .replace(EMAIL_REGEX, '[REDACTED:EMAIL]');
}

/**
 * Deeply redact an object, array, or primitive data payload.
 * Safely handles circular references and sanitizes sensitive dictionary keys.
 */
export function redactDeep<T>(obj: T, seen = new WeakSet<object>()): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return redactValue(obj) as unknown as T;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return obj;
  }

  if (seen.has(obj)) {
    return '[CIRCULAR]' as unknown as T;
  }
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => redactDeep(item, seen)) as unknown as T;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_TOKEN.test(key)) {
      result[key] = '[REDACTED:TOKEN]';
    } else if (SENSITIVE_KEY_NATIONAL_ID.test(key)) {
      result[key] = '[REDACTED:NATIONAL_ID]';
    } else if (SENSITIVE_KEY_PHONE.test(key)) {
      result[key] = '[REDACTED:PHONE]';
    } else if (SENSITIVE_KEY_EMAIL.test(key)) {
      result[key] = '[REDACTED:EMAIL]';
    } else {
      result[key] = redactDeep(value, seen);
    }
  }

  return result as T;
}
