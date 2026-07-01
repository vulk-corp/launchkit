import { enqueueError } from './error-capture';
import { normalizeThrown } from './normalize-thrown';

let _originalFetch: typeof fetch | null = null;
let _installed = false;
let _apiEndpoint = '';

export function startNetworkCapture(apiEndpoint: string): void {
  if (_installed) return;
  _installed = true;
  _apiEndpoint = apiEndpoint;

  const original = window.fetch;
  _originalFetch = original;

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
      method = init?.method?.toUpperCase() || 'GET';
      if (isSdkEndpoint(url)) return original(input, init);
    } catch {
      // Instrumentation must never keep the host request from going out.
      return original(input, init);
    }

    try {
      const response = await original(input, init);

      if (response.status >= 400) {
        try {
          enqueueError({
            message: `HTTP ${response.status} ${response.statusText} - ${method} ${truncateUrl(url)}`,
            stack: null,
            url: window.location.href,
            source: 'network',
            metadata: {
              status: response.status,
              method,
              requestUrl: truncateUrl(url),
              statusText: response.statusText,
            },
          });
        } catch {
          // never crash the host app
        }
      }

      return response;
    } catch (error: unknown) {
      try {
        const { message, stack } = normalizeThrown(error);
        enqueueError({
          message: `Network error - ${method} ${truncateUrl(url)}: ${message}`,
          stack,
          url: window.location.href,
          source: 'network',
          metadata: {
            status: 0,
            method,
            requestUrl: truncateUrl(url),
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
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

function isSdkEndpoint(url: string): boolean {
  if (_apiEndpoint === '') return false;
  try {
    // Compare origins, not a raw string prefix: a look-alike host or a longer
    // port that merely starts with the endpoint string must not be misread as an
    // SDK self-call and dropped from capture.
    const base = typeof location !== 'undefined' ? location.href : undefined;
    return new URL(url, base).origin === new URL(_apiEndpoint, base).origin;
  } catch {
    return false;
  }
}

function truncateUrl(url: string): string {
  return url.length > 200 ? url.slice(0, 200) + '...' : url;
}
