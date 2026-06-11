import {
  MAX_MESSAGE_LENGTH,
  MAX_STACK_LENGTH,
  MAX_URL_LENGTH,
  normalizeThrown,
  sanitizeAndTruncate,
  truncateMessage,
} from './normalize-thrown';
import { sendTelemetry } from './telemetry-sender';

const BATCH_INTERVAL_MS = 10_000;
const BATCH_SIZE_THRESHOLD = 5;

export type ErrorSource = 'uncaught' | 'unhandled-rejection' | 'console' | 'network';

export interface CapturedError {
  message: string;
  stack: string | null;
  url: string | null;
  source: ErrorSource;
  metadata?: Record<string, unknown>;
}

let _queue: CapturedError[] = [];
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _buildSlug: string | null = null;
let _installed = false;
let _originalOnError: OnErrorEventHandler = null;
let _rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
let _originalConsoleError: (typeof console.error) | null = null;
let _capturing = false;

export function startErrorCapture(buildSlug: string): void {
  if (_installed) return;
  _installed = true;
  _buildSlug = buildSlug;

  _originalOnError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    // Capture must never block the host app's own onerror chain below: a
    // poisoned `error` (e.g. a throwing stack getter) drops this one capture,
    // nothing more.
    try {
      // Non-Error throws reach onerror as a browser-stringified `message`
      // ("Uncaught [object Object]"); derive a readable one from the thrown
      // value instead. Errors (and absent `error`, e.g. cross-origin
      // "Script error.") keep the browser message untouched.
      const normalized =
        error != null && !(error instanceof Error)
          ? normalizeThrown(error)
          : {
              message: String(message),
              stack: typeof error?.stack === 'string' ? error.stack : null,
            };
      enqueueError({
        message: normalized.message,
        stack: normalized.stack,
        url: source ?? window.location.href,
        source: 'uncaught',
      });
    } catch {
      // swallow: telemetry loss is acceptable, breaking the host app is not
    }
    if (_originalOnError) {
      return _originalOnError.call(window, message, source, lineno, colno, error);
    }
    return false;
  };

  _rejectionHandler = (event: PromiseRejectionEvent) => {
    const { message, stack } = normalizeThrown(event.reason);
    enqueueError({
      message,
      stack,
      url: window.location.href,
      source: 'unhandled-rejection',
    });
  };
  window.addEventListener('unhandledrejection', _rejectionHandler);

  _originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (_capturing) {
      _originalConsoleError!.apply(console, args);
      return;
    }
    _capturing = true;
    try {
      const extracted = extractErrorFromArgs(args);
      enqueueError({
        message: extracted.message,
        stack: extracted.stack,
        url: window.location.href,
        source: 'console',
      });
    } catch {
      // Must never throw from the wrapper
    } finally {
      _capturing = false;
    }
    _originalConsoleError!.apply(console, args);
  };

  _intervalId = setInterval(flush, BATCH_INTERVAL_MS);
}

export function stopErrorCapture(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  flush();

  window.onerror = _originalOnError;
  if (_rejectionHandler) {
    window.removeEventListener('unhandledrejection', _rejectionHandler);
    _rejectionHandler = null;
  }
  if (_originalConsoleError) {
    console.error = _originalConsoleError;
    _originalConsoleError = null;
  }
  _originalOnError = null;
  _installed = false;
}

export function enqueueError(error: CapturedError): void {
  // Single wire-validity chokepoint for every capture path: the server
  // rejects any item whose message exceeds 5000 chars, stack exceeds 10000,
  // url exceeds 2048, carries a non-string where a string is expected, or
  // contains a lone surrogate — and the rejection drops the whole batch.
  const message = truncateMessage(error.message);
  const stack =
    typeof error.stack === 'string' ? sanitizeAndTruncate(error.stack, MAX_STACK_LENGTH) : null;
  const url =
    typeof error.url === 'string' ? sanitizeAndTruncate(error.url, MAX_URL_LENGTH) : null;
  _queue.push({ ...error, message, stack, url });
  if (_queue.length >= BATCH_SIZE_THRESHOLD) {
    flush();
  }
}

function flush(): void {
  if (_queue.length === 0 || !_buildSlug) return;

  const batch = _queue.splice(0);
  sendTelemetry('/api/telemetry/errors', {
    buildSlug: _buildSlug,
    errors: batch,
  });
}

function extractErrorFromArgs(args: unknown[]): { message: string; stack: string | null } {
  for (const arg of args) {
    if (arg instanceof Error) {
      // normalizeThrown guards subclasses whose message/stack getters return
      // non-strings or throw. An Error with an empty message still reads
      // better as its String() form ("Error: ..."), so keep that fallback.
      const normalized = normalizeThrown(arg);
      return {
        message: normalized.message || String(arg),
        stack: normalized.stack,
      };
    }
  }
  // Budget loop: each kept arg gets its full normalization pass, but once the
  // joined length passes the message cap any remaining args are dead weight —
  // enqueueError cuts them anyway, so skip their stringify cost entirely.
  const parts: string[] = [];
  let budget = 0;
  for (const arg of args) {
    if (budget > MAX_MESSAGE_LENGTH) break;
    const part = typeof arg === 'string' ? arg : normalizeThrown(arg).message;
    parts.push(part);
    budget += part.length + 1;
  }
  return { message: parts.join(' '), stack: null };
}
