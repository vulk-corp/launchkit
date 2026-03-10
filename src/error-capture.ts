import { sendTelemetry } from './telemetry-sender';

const BATCH_INTERVAL_MS = 10_000;
const BATCH_SIZE_THRESHOLD = 5;

interface CapturedError {
  message: string;
  stack: string | null;
  url: string | null;
}

let _queue: CapturedError[] = [];
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _buildSlug: string | null = null;
let _installed = false;
let _originalOnError: OnErrorEventHandler = null;
let _rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

export function startErrorCapture(buildSlug: string): void {
  if (_installed) return;
  _installed = true;
  _buildSlug = buildSlug;

  _originalOnError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    enqueue({
      message: String(message),
      stack: error?.stack ?? null,
      url: source ?? window.location.href,
    });
    if (_originalOnError) {
      return _originalOnError.call(window, message, source, lineno, colno, error);
    }
    return false;
  };

  _rejectionHandler = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    enqueue({
      message: reason?.message ?? String(reason),
      stack: reason?.stack ?? null,
      url: window.location.href,
    });
  };
  window.addEventListener('unhandledrejection', _rejectionHandler);

  _intervalId = setInterval(flush, BATCH_INTERVAL_MS);
}

export function stopErrorCapture(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  flush();

  // Restore original handlers
  window.onerror = _originalOnError;
  if (_rejectionHandler) {
    window.removeEventListener('unhandledrejection', _rejectionHandler);
    _rejectionHandler = null;
  }
  _originalOnError = null;
  _installed = false;
}

function enqueue(error: CapturedError): void {
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
