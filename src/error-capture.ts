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

export function startErrorCapture(buildSlug: string): void {
  if (_installed) return;
  _installed = true;
  _buildSlug = buildSlug;

  const originalOnError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    enqueue({
      message: String(message),
      stack: error?.stack ?? null,
      url: source ?? window.location.href,
    });
    if (originalOnError) {
      return originalOnError.call(window, message, source, lineno, colno, error);
    }
    return false;
  };

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    enqueue({
      message: reason?.message ?? String(reason),
      stack: reason?.stack ?? null,
      url: window.location.href,
    });
  });

  _intervalId = setInterval(flush, BATCH_INTERVAL_MS);
}

export function stopErrorCapture(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  flush();
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
