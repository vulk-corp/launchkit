export const MAX_MESSAGE_LENGTH = 5000;
export const MAX_STACK_LENGTH = 10000;
export const MAX_URL_LENGTH = 2048;

const MAX_GETTER_CHAIN_DEPTH = 3;

const FALLBACK_MESSAGE = '[error details could not be read]';

export interface NormalizedThrown {
  message: string;
  stack: string | null;
}

export function truncateMessage(message: string): string {
  return sanitizeAndTruncate(message, MAX_MESSAGE_LENGTH);
}

export function sanitizeAndTruncate(value: string, max: number): string {
  const wellFormed = toWellFormedString(value);
  if (wellFormed.length <= max) return wellFormed;
  const cut = wellFormed.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const SURROGATE_RUN = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

function toWellFormedString(value: string): string {
  const candidate = value as string & { toWellFormed?: () => string };
  if (typeof candidate.toWellFormed === 'function') {
    return candidate.toWellFormed();
  }
  return value.replace(SURROGATE_RUN, (unit) => (unit.length === 2 ? unit : '�'));
}

export function normalizeThrown(value: unknown): NormalizedThrown {
  try {
    return normalize(value, 0);
  } catch {
    return { message: FALLBACK_MESSAGE, stack: null };
  }
}

function normalize(value: unknown, depth: number): NormalizedThrown {
  if (depth > MAX_GETTER_CHAIN_DEPTH) {
    return { message: FALLBACK_MESSAGE, stack: null };
  }
  if (value instanceof Error) {
    const { message, stack } = value;
    return {
      message: typeof message === 'string' ? message : normalize(message, depth + 1).message,
      stack: typeof stack === 'string' ? stack : null,
    };
  }
  if (typeof value === 'string') {
    return { message: value, stack: null };
  }
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return { message: String(value), stack: null };
  }

  const record = value as Record<string, unknown>;
  const stack = typeof record.stack === 'string' ? record.stack : null;

  if (typeof record.message === 'string' && record.message !== '') {
    return { message: record.message, stack };
  }

  if (depth === 0 && 'error' in record) {
    const inner = normalize(record.error, depth + 1);
    return { message: inner.message, stack: inner.stack ?? stack };
  }

  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') {
      return { message: json, stack };
    }
  } catch {
    // circular reference, BigInt property, throwing toJSON
  }

  return { message: FALLBACK_MESSAGE, stack };
}
