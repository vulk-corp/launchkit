import { enqueueError } from './error-capture';
import { isSdkTelemetryUrl, redactNetworkUrl } from './network-url';
import { normalizeThrown } from './normalize-thrown';
import { effectiveFetchSignal, expectedNetworkState, isExpectedRequestCancellation } from './network-outcome';

const DELETE_CORRELATION_WINDOW_MS = 5_000;
const MAX_DELETE_CORRELATIONS = 100;

let _originalFetch: typeof fetch | null = null;
let _installed = false;
let _apiEndpoint = '';
let _clearDeleteCorrelations: (() => void) | null = null;

export function startNetworkCapture(apiEndpoint: string): void {
  if (_installed) return;
  _installed = true;
  _apiEndpoint = apiEndpoint;

  const original = window.fetch;
  _originalFetch = original;
  const successfulDeletes = new Map<string, number>();
  _clearDeleteCorrelations = () => successfulDeletes.clear();

  // Close over the original so a reference retained across teardown still
  // forwards, and never throw before delegating to the host fetch.
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let url: string;
    let method: string;
    try {
      url = resolveUrl(input);
      const requestMethod = typeof Request !== 'undefined' && input instanceof Request
        ? input.method
        : 'GET';
      method = (init?.method ?? requestMethod).toUpperCase();
      if (isSdkTelemetryUrl(url, _apiEndpoint)) return original(input, init);
    } catch {
      // Instrumentation must never keep the host request from going out.
      return original(input, init);
    }

    const signal = effectiveFetchSignal(input, init);
    const startedAt = Date.now();
    try {
      const response = await original(input, init);

      if (response.status >= 400 && !expectedNetworkState(
        response.status,
        method,
        name => response.headers.get(name),
      )) {
        try {
          const requestUrl = truncateUrl(redactNetworkUrl(url));
          const key = correlationUrl(url);
          const deletedAt = key === null ? undefined : successfulDeletes.get(key);
          const deleteAge = deletedAt === undefined ? undefined : startedAt - deletedAt;
          enqueueError({
            message: `HTTP ${response.status} ${response.statusText} - ${method} ${requestUrl}`,
            stack: null,
            url: window.location.href,
            source: 'network',
            metadata: {
              status: response.status,
              method,
              requestUrl,
              statusText: response.statusText,
              ...(method === 'GET' && response.status === 404
                && deleteAge !== undefined && deleteAge >= 0
                && deleteAge <= DELETE_CORRELATION_WINDOW_MS
                ? { successfulDeleteAgeMs: deleteAge }
                : {}),
            },
          });
        } catch {
          // never crash the host app
        }
      }

      if (method === 'DELETE' && response.ok) {
        try {
          const now = Date.now();
          for (const [key, deletedAt] of successfulDeletes) {
            if (now - deletedAt > DELETE_CORRELATION_WINDOW_MS) successfulDeletes.delete(key);
          }
          const key = correlationUrl(url);
          if (key === null) return response;
          successfulDeletes.delete(key);
          if (successfulDeletes.size >= MAX_DELETE_CORRELATIONS) {
            const oldest = successfulDeletes.keys().next().value;
            if (oldest !== undefined) successfulDeletes.delete(oldest);
          }
          successfulDeletes.set(key, now);
        } catch {
          // Correlation metadata must never affect the host request.
        }
      }

      return response;
    } catch (error: unknown) {
      if (isExpectedRequestCancellation(error, signal)) throw error;
      try {
        const { message, stack } = normalizeThrown(error);
        const requestUrl = truncateUrl(redactNetworkUrl(url));
        enqueueError({
          message: `Network error - ${method} ${requestUrl}: ${message}`,
          stack,
          url: window.location.href,
          source: 'network',
          metadata: {
            status: 0,
            method,
            requestUrl,
            statusText: 'Network Error',
          },
        });
      } catch {
        // never crash
      }
      throw error;
    }
  };
}

export function stopNetworkCapture(): void {
  if (_originalFetch) {
    window.fetch = _originalFetch;
    _originalFetch = null;
  }
  _installed = false;
  _clearDeleteCorrelations?.();
  _clearDeleteCorrelations = null;
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

function truncateUrl(url: string): string {
  return url.length > 200 ? url.slice(0, 200) + '...' : url;
}

function correlationUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.href);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}
