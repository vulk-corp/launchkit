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
    enqueueError({
      message: String(message),
      stack: error?.stack ?? null,
      url: source ?? window.location.href,
      source: 'uncaught',
    });
    if (_originalOnError) {
      return _originalOnError.call(window, message, source, lineno, colno, error);
    }
    return false;
  };

  _rejectionHandler = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    enqueueError({
      message: reason?.message ?? String(reason),
      stack: reason?.stack ?? null,
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
  _queue.push(error);
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
      return {
        message: arg.message || String(arg),
        stack: arg.stack ?? null,
      };
    }
  }
  const message = args
    .map((a) => (typeof a === 'string' ? a : String(a)))
    .join(' ');
  return { message: message.slice(0, 5000), stack: null };
}
