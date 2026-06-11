import { enqueueError } from './error-capture';
import { normalizeThrown } from './normalize-thrown';

let _originalFetch: typeof fetch | null = null;
let _installed = false;
let _apiEndpoint = '';

export function startNetworkCapture(apiEndpoint: string): void {
  if (_installed) return;
  _installed = true;
  _apiEndpoint = apiEndpoint;

  _originalFetch = window.fetch;

  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = resolveUrl(input);
    const method = init?.method?.toUpperCase() || 'GET';

    if (url.startsWith(_apiEndpoint)) {
      return _originalFetch!(input, init);
    }

    try {
      const response = await _originalFetch!(input, init);

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
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

function truncateUrl(url: string): string {
  return url.length > 200 ? url.slice(0, 200) + '...' : url;
}
