import { enqueueError } from './error-capture';
import { isSdkTelemetryUrl, redactNetworkUrl } from './network-url';
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
      if (isSdkTelemetryUrl(url, _apiEndpoint)) return original(input, init);
    } catch {
      // Instrumentation must never keep the host request from going out.
      return original(input, init);
    }

    try {
      const response = await original(input, init);

      if (response.status >= 400) {
        try {
          const requestUrl = truncateUrl(redactNetworkUrl(url));
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
