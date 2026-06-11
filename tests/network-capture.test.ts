import { startNetworkCapture, stopNetworkCapture } from '../src/network-capture';
import { enqueueError } from '../src/error-capture';

vi.mock('../src/error-capture', () => ({
  enqueueError: vi.fn(),
}));

const mockEnqueue = vi.mocked(enqueueError);
let originalFetch: typeof fetch;

beforeEach(() => {
  mockEnqueue.mockClear();
  originalFetch = window.fetch;
});

afterEach(() => {
  stopNetworkCapture();
  window.fetch = originalFetch;
});

describe('startNetworkCapture / stopNetworkCapture', () => {
  it('wraps window.fetch on start', () => {
    const before = window.fetch;
    startNetworkCapture('https://api.bworlds.co');
    expect(window.fetch).not.toBe(before);
  });

  it('captures HTTP 4xx responses with source: network', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );

    startNetworkCapture('https://api.bworlds.co');
    const resp = await fetch('https://example.com/missing');

    expect(resp.status).toBe(404);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'network',
        metadata: expect.objectContaining({ status: 404, method: 'GET' }),
      }),
    );
  });

  it('captures HTTP 5xx responses with source: network', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    startNetworkCapture('https://api.bworlds.co');
    await fetch('https://example.com/broken');

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'network',
        metadata: expect.objectContaining({ status: 500 }),
      }),
    );
  });

  it('does not capture successful responses (200)', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200, statusText: 'OK' }),
    );

    startNetworkCapture('https://api.bworlds.co');
    await fetch('https://example.com/ok');

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does not capture 3xx responses', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 301, statusText: 'Moved Permanently' }),
    );

    startNetworkCapture('https://api.bworlds.co');
    await fetch('https://example.com/redirect');

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('captures network failures (fetch throws)', async () => {
    window.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://does-not-exist.invalid/foo')).rejects.toThrow('Failed to fetch');

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'network',
        message: expect.stringContaining('Failed to fetch'),
        metadata: expect.objectContaining({ status: 0 }),
      }),
    );
  });

  it('network_non_error: fetch rejecting with non-Error keeps readable suffix', async () => {
    const reason = { message: 'socket hang up' };
    window.fetch = vi.fn().mockRejectedValue(reason);

    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/flaky')).rejects.toBe(reason);

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'network',
        message: 'Network error - GET https://example.com/flaky: socket hang up',
        metadata: expect.objectContaining({ status: 0 }),
      }),
    );
  });

  it('captures fetch rejecting with a plain string verbatim in the suffix', async () => {
    window.fetch = vi.fn().mockRejectedValue('connection reset');

    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/flaky')).rejects.toBe('connection reset');

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'network',
        message: 'Network error - GET https://example.com/flaky: connection reset',
      }),
    );
  });

  it('captures aborted requests (DOMException) with a readable message', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    window.fetch = vi.fn().mockRejectedValue(abort);

    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/slow')).rejects.toBe(abort);

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'network',
        message: 'Network error - GET https://example.com/slow: The operation was aborted.',
      }),
    );
  });

  it('does not capture SDK telemetry calls', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Error', { status: 500, statusText: 'Error' }),
    );

    startNetworkCapture('https://api.bworlds.co');
    await fetch('https://api.bworlds.co/api/telemetry/errors');

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does not capture custom apiEndpoint calls', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Error', { status: 500, statusText: 'Error' }),
    );

    startNetworkCapture('http://localhost:9941');
    await fetch('http://localhost:9941/api/telemetry/errors');

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('returns the original Response object to the caller', async () => {
    const mockResponse = new Response('body content', { status: 403, statusText: 'Forbidden' });
    window.fetch = vi.fn().mockResolvedValue(mockResponse);

    startNetworkCapture('https://api.bworlds.co');
    const resp = await fetch('https://example.com/forbidden');

    expect(resp).toBe(mockResponse);
    expect(await resp.text()).toBe('body content');
  });

  it('re-throws network errors to the caller', async () => {
    const error = new TypeError('Network request failed');
    window.fetch = vi.fn().mockRejectedValue(error);

    startNetworkCapture('https://api.bworlds.co');

    try {
      await fetch('https://example.com/fail');
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBe(error);
    }
  });

  it('includes structured metadata', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
    );

    startNetworkCapture('https://api.bworlds.co');
    await fetch('https://example.com/resource', { method: 'POST' });

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          status: 403,
          method: 'POST',
          requestUrl: 'https://example.com/resource',
          statusText: 'Forbidden',
        },
      }),
    );
  });

  it('returns the response unchanged when enqueueError itself throws', async () => {
    mockEnqueue.mockImplementationOnce(() => {
      throw new Error('enqueue exploded');
    });
    const mockResponse = new Response('Server Error', {
      status: 500,
      statusText: 'Internal Server Error',
    });
    window.fetch = vi.fn().mockResolvedValue(mockResponse);

    startNetworkCapture('https://api.bworlds.co');
    const resp = await fetch('https://example.com/broken');

    expect(resp).toBe(mockResponse);
  });

  it('rethrows the original rejection when enqueueError itself throws', async () => {
    mockEnqueue.mockImplementationOnce(() => {
      throw new Error('enqueue exploded');
    });
    const failure = new TypeError('Failed to fetch');
    window.fetch = vi.fn().mockRejectedValue(failure);

    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/down')).rejects.toBe(failure);
  });

  it('restores original fetch on stop', () => {
    const original = window.fetch;
    startNetworkCapture('https://api.bworlds.co');
    expect(window.fetch).not.toBe(original);

    stopNetworkCapture();
    expect(window.fetch).toBe(original);
  });

  it('prevents double-install', () => {
    startNetworkCapture('https://api.bworlds.co');
    const wrapped = window.fetch;

    startNetworkCapture('https://api.bworlds.co');
    expect(window.fetch).toBe(wrapped);
  });

  it('truncates long URLs in error messages', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Error', { status: 500, statusText: 'Error' }),
    );

    const longUrl = 'https://example.com/' + 'a'.repeat(300);
    startNetworkCapture('https://api.bworlds.co');
    await fetch(longUrl);

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('...'),
        metadata: expect.objectContaining({
          requestUrl: expect.stringContaining('...'),
        }),
      }),
    );
  });
});
