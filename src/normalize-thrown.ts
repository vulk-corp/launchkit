/**
 * Maximum captured message length, matching the server's
 * ClientErrorItem.message Field(max_length=5000) so a single oversized
 * message can never 422 an entire telemetry batch.
 */
export const MAX_MESSAGE_LENGTH = 5000;

/** Server cap for ClientErrorItem.stack (max_length=10000). */
export const MAX_STACK_LENGTH = 10000;

/** Server cap for ClientErrorItem.url (max_length=2048). */
export const MAX_URL_LENGTH = 2048;

/**
 * Hard recursion cap for getter chains: an Error subclass whose message
 * getter yields another Error (or itself) would otherwise recurse to stack
 * overflow — caught, but costly inside hot capture paths. Legitimate chains
 * never exceed depth 2.
 */
const MAX_GETTER_CHAIN_DEPTH = 3;

/**
 * Builder-facing fallback for values whose details cannot be derived. Shown
 * on the dashboard error row, alert emails, and Fix prompts, so it must read
 * as plain language, and a single literal keeps server-side grouping intact.
 */
const FALLBACK_MESSAGE = '[error details could not be read]';

export interface NormalizedThrown {
  message: string;
  stack: string | null;
}

/**
 * Make a message wire-safe: well-formed, capped at MAX_MESSAGE_LENGTH, never
 * cut mid-surrogate-pair. A lone surrogate anywhere in the string produces a
 * payload the server cannot UTF-8 encode ("surrogates not allowed"), and the
 * resulting rejection drops the entire telemetry batch.
 */
export function truncateMessage(message: string): string {
  return sanitizeAndTruncate(message, MAX_MESSAGE_LENGTH);
}

/**
 * Make any string safe for the telemetry wire: replace unpaired surrogates
 * with U+FFFD, then cap the length without ever ending on a lone high
 * surrogate (a cut that splits an emoji's surrogate pair would reintroduce
 * the encoding failure the well-formed pass just removed).
 */
export function sanitizeAndTruncate(value: string, max: number): string {
  const wellFormed = toWellFormedString(value);
  if (wellFormed.length <= max) return wellFormed;
  const cut = wellFormed.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// Matches a complete surrogate pair (kept as-is) or a lone surrogate
// (replaced): the pair alternative wins first, so only unpaired units match
// alone.
const SURROGATE_RUN = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/**
 * `String.prototype.toWellFormed` (ES2024) when the engine provides it, with
 * a regex fallback for older engines. The compile target's lib predates the
 * method, hence the feature-detect cast.
 */
function toWellFormedString(value: string): string {
  const candidate = value as string & { toWellFormed?: () => string };
  if (typeof candidate.toWellFormed === 'function') {
    return candidate.toWellFormed();
  }
  return value.replace(SURROGATE_RUN, (unit) => (unit.length === 2 ? unit : '\uFFFD'));
}

/**
 * Derive a readable message (and stack when available) from any thrown
 * value: Error, string, primitive, or arbitrary object. Never throws —
 * capture paths must never break the host app.
 */
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
    // Subclasses can override message/stack with getters that return
    // non-strings; guard both so the telemetry payload stays string-typed
    // (a non-string field 422s the whole batch server-side). Plain Errors
    // always carry string message/stack, so their output is unchanged.
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

  // An empty message would surface as "Unknown error" server-side; fall
  // through to the error field or JSON form, which carry more signal.
  if (typeof record.message === 'string' && record.message !== '') {
    return { message: record.message, stack };
  }

  // Single error-field hop: only the outermost object delegates to its
  // `error` property; deeper levels serialize instead.
  if (depth === 0 && 'error' in record) {
    const inner = normalize(record.error, depth + 1);
    return { message: inner.message, stack: inner.stack ?? stack };
  }

  try {
    // Full stringify ahead of enqueueError's MAX_MESSAGE_LENGTH truncation is
    // deliberate: JSON size is unknowable without serializing, and a budget
    // replacer would alter the kept prefix. Cost is one O(size) pass per
    // captured value; an engine RangeError falls through to the fallback
    // below.
    const json = JSON.stringify(value);
    if (typeof json === 'string') {
      return { message: json, stack };
    }
  } catch {
    // circular reference, BigInt property, throwing toJSON — fall through
  }

  return { message: FALLBACK_MESSAGE, stack };
}
