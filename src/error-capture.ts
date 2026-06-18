import {
  MAX_MESSAGE_LENGTH,
  MAX_STACK_LENGTH,
  MAX_URL_LENGTH,
  normalizeThrown,
  sanitizeAndTruncate,
  truncateMessage,
} from './normalize-thrown';
import { sendTelemetry } from './telemetry-sender';
import { getReplaySessionId } from './session-state';

const BATCH_INTERVAL_MS = 10_000;
const BATCH_SIZE_THRESHOLD = 5;

export type ErrorSource = 'uncaught' | 'unhandled-rejection' | 'console' | 'network';

/** What capture paths provide. Session link fields are stamped internally. */
export interface CapturedErrorInput {
  message: string;
  stack: string | null;
  url: string | null;
  source: ErrorSource;
  metadata?: Record<string, unknown>;
}

/**
 * Wire shape sent to /api/telemetry/errors. `sessionId` is the replay
 * session active at capture time (null when replay is not recording) and
 * `capturedAt` is the client-clock capture timestamp in epoch ms — both
 * stamped inside enqueueError, never at flush, so a batch spanning a session
 * rotation keeps each error on the session it actually happened in.
 */
export interface CapturedError extends CapturedErrorInput {
  sessionId: string | null;
  capturedAt: number;
}

let _queue: CapturedError[] = [];
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _buildSlug: string | null = null;
let _installed = false;
let _originalOnError: OnErrorEventHandler = null;
let _rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
let _originalConsoleError: (typeof console.error) | null = null;
let _capturing = false;
let _visibilityFlushHandler: (() => void) | null = null;

export function startErrorCapture(buildSlug: string): void {
  if (_installed) return;
  _installed = true;
  _buildSlug = buildSlug;

  _originalOnError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    try {
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
      // telemetry loss is acceptable, breaking the host app is not
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

  // Errors captured in the final seconds of a page life (often the fatal
  // ones) would otherwise sit in the queue past unload and never reach the
  // API. sendTelemetry uses keepalive fetch, so a flush at hidden survives
  // tab close and navigation.
  _visibilityFlushHandler = () => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  };
  document.addEventListener('visibilitychange', _visibilityFlushHandler);
}

export function stopErrorCapture(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  if (_visibilityFlushHandler) {
    document.removeEventListener('visibilitychange', _visibilityFlushHandler);
    _visibilityFlushHandler = null;
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

export function enqueueError(error: CapturedErrorInput): void {
  const message = truncateMessage(error.message);
  const stack =
    typeof error.stack === 'string' ? sanitizeAndTruncate(error.stack, MAX_STACK_LENGTH) : null;
  const url =
    typeof error.url === 'string' ? sanitizeAndTruncate(error.url, MAX_URL_LENGTH) : null;
  _queue.push({
    ...error,
    message,
    stack,
    url,
    sessionId: getReplaySessionId(),
    capturedAt: Date.now(),
  });
  if (_queue.length >= BATCH_SIZE_THRESHOLD) {
    flush();
  }
}

/**
 * Stamp queued errors that were captured before replay became active.
 * Called by replay.ts the moment recording genuinely starts (rrweb loaded,
 * stop handle obtained), closing the page-load gap where errors fire during
 * the replay module's dynamic import. Only null-session entries are touched
 * — errors stamped at capture time keep the session they happened in. The
 * 10s flush interval bounds queue age, so a back-stamped error is at most
 * one flush window older than the recording; assembly clamps its timestamp
 * to the session window.
 */
export function backstampQueuedErrors(sessionId: string): void {
  for (const error of _queue) {
    if (error.sessionId === null) {
      error.sessionId = sessionId;
    }
  }
}

/**
 * Remove the session link from queued errors stamped with the given session.
 * Called by replay.ts when a FRESH session's replay start fails (rrweb import
 * error or no stop handle) — that session will never record or assemble, so
 * its id must not reach the wire. Resumed sessions are never un-stamped:
 * their prior footage is legitimate.
 */
export function unstampQueuedErrors(sessionId: string): void {
  for (const error of _queue) {
    if (error.sessionId === sessionId) {
      error.sessionId = null;
    }
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
      const normalized = normalizeThrown(arg);
      return {
        message: normalized.message || String(arg),
        stack: normalized.stack,
      };
    }
  }
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
