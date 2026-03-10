/**
 * Error capture module: intercepts window.onerror and unhandledrejection
 * events, batches them, and sends to the BWORLDS API.
 *
 * Captures client-side JS errors only. Not a Sentry replacement.
 * Batch sends every 10 seconds or when queue hits 5 errors.
 */

import { sendTelemetry } from './telemetry-sender';

const BATCH_INTERVAL_MS = 10_000; // 10 seconds
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

  // Global error handler
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

  // Unhandled promise rejection handler
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    enqueue({
      message: reason?.message ?? String(reason),
      stack: reason?.stack ?? null,
      url: window.location.href,
    });
  });

  // Periodic flush
  _intervalId = setInterval(flush, BATCH_INTERVAL_MS);
}

export function stopErrorCapture(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  flush(); // Send remaining errors
}

function enqueue(error: CapturedError): void {
  _queue.push(error);
  if (_queue.length >= BATCH_SIZE_THRESHOLD) {
    flush();
  }
}

async function flush(): Promise<void> {
  if (_queue.length === 0 || !_buildSlug) return;

  const batch = _queue.splice(0);
  await sendTelemetry('/api/telemetry/errors', {
    buildSlug: _buildSlug,
    errors: batch,
  });
}
