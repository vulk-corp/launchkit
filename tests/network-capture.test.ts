import { startNetworkCapture, stopNetworkCapture } from '../src/network-capture';
import { enqueueError } from '../src/error-capture';
import { abortExpectedRequest } from '../src/cancellation';

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
  vi.useRealTimers();
});

describe('startNetworkCapture / stopNetworkCapture', () => {
  it.each(['cleanup', 'navigation', 'replacement'])('omits an explicitly marked %s cancellation from product errors', async (cause) => {
    const controller = new AbortController();
    const cancellation = new DOMException('Expected lifecycle cancellation', 'AbortError');
    Object.defineProperty(cancellation, Symbol.for('@bworlds/launchkit/expected-cancellation'), { value: cause });
    window.fetch = vi.fn().mockRejectedValue(cancellation);
    startNetworkCapture('https://api.bworlds.co');

    controller.abort(cancellation);
    await expect(fetch('https://example.com/live', { signal: controller.signal })).rejects.toBe(cancellation);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses the following signal on a Request (cloned: %s)', async (clone) => {
    const controller = new AbortController();
    const input = new Request('https://example.com/live', { signal: controller.signal });
    abortExpectedRequest(controller, 'navigation');
    const cancellation = controller.signal.reason;
    window.fetch = vi.fn().mockRejectedValue(cancellation);
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch(clone ? input.clone() : input)).rejects.toBe(cancellation);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it.each([null, new AbortController().signal])('honors init.signal override instead of the Request signal: %s', async (signal) => {
    const controller = new AbortController();
    const input = new Request('https://example.com/live', { signal: controller.signal });
    abortExpectedRequest(controller, 'cleanup');
    const cancellation = controller.signal.reason;
    window.fetch = vi.fn().mockRejectedValue(cancellation);
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch(input, { signal })).rejects.toBe(cancellation);

    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('uses an explicitly supplied expected signal instead of an unmarked Request signal', async () => {
    const input = new Request('https://example.com/live');
    const controller = new AbortController();
    abortExpectedRequest(controller, 'replacement');
    window.fetch = vi.fn().mockRejectedValue(controller.signal.reason);
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch(input, { signal: controller.signal })).rejects.toBe(controller.signal.reason);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('keeps a genuine network rejection when cleanup occurs before its catch runs', async () => {
    const controller = new AbortController();
    const failure = new TypeError('Failed to fetch');
    window.fetch = vi.fn().mockRejectedValue(failure);
    startNetworkCapture('https://api.bworlds.co');

    const result = fetch('https://example.com/live', { signal: controller.signal });
    abortExpectedRequest(controller, 'cleanup');

    await expect(result).rejects.toBe(failure);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Failed to fetch') }));
  });

  it('keeps a different AbortError even when the request signal has expected provenance', async () => {
    const controller = new AbortController();
    abortExpectedRequest(controller, 'cleanup');
    const unrelated = new DOMException(controller.signal.reason.message, 'AbortError');
    window.fetch = vi.fn().mockRejectedValue(unrelated);
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/live', { signal: controller.signal })).rejects.toBe(unrelated);

    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    new DOMException('The operation was aborted.', 'AbortError'),
    new DOMException('Replay request timed out.', 'TimeoutError'),
    new Error('Agent stream timed out'),
    new TypeError('Failed to fetch'),
  ])('reports an unmarked signal rejection, including timeouts: %s', async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    const failure = controller.signal.reason;
    window.fetch = vi.fn().mockRejectedValue(failure);
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://supabase.example/storage/v1/object/replay/chunk', { signal: controller.signal })).rejects.toBe(failure);

    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('reports native AbortSignal.timeout and a composite signal where the timeout wins', async () => {
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(0);
    const signal = AbortSignal.any([controller.signal, timeout]);
    await new Promise<void>(resolve => timeout.addEventListener('abort', () => resolve(), { once: true }));
    abortExpectedRequest(controller, 'cleanup');
    window.fetch = vi.fn().mockRejectedValue(signal.reason);
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/live', { signal })).rejects.toBe(timeout.reason);

    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('recognizes a composite signal only when the explicit lifecycle cancellation wins', async () => {
    const controller = new AbortController();
    const other = new AbortController();
    const signal = AbortSignal.any([controller.signal, other.signal]);
    abortExpectedRequest(controller, 'cleanup');
    other.abort(new DOMException('Timed out', 'TimeoutError'));
    window.fetch = vi.fn().mockRejectedValue(signal.reason);
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/live', { signal })).rejects.toBe(controller.signal.reason);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'unknown'])('does not trust an unsupported provenance reason: %s', async (cause) => {
    const controller = new AbortController();
    const failure = new DOMException('Aborted', 'AbortError');
    Object.defineProperty(failure, Symbol.for('@bworlds/launchkit/expected-cancellation'), { value: cause });
    controller.abort(failure);
    window.fetch = vi.fn().mockRejectedValue(failure);
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/live', { signal: controller.signal })).rejects.toBe(failure);

    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('does not execute a provenance getter or hide its error', async () => {
    const controller = new AbortController();
    const failure = new DOMException('Aborted', 'AbortError');
    const getter = vi.fn(() => 'cleanup');
    Object.defineProperty(failure, Symbol.for('@bworlds/launchkit/expected-cancellation'), { get: getter });
    controller.abort(failure);
    window.fetch = vi.fn().mockRejectedValue(failure);
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/live', { signal: controller.signal })).rejects.toBe(failure);

    expect(getter).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('keeps an HTTP failure even if the signal is marked as expected cancellation', async () => {
    const controller = new AbortController();
    abortExpectedRequest(controller, 'cleanup');
    const response = new Response('Server error', { status: 500 });
    window.fetch = vi.fn().mockResolvedValue(response);
    startNetworkCapture('https://api.bworlds.co');

    expect(await fetch('https://example.com/live', { signal: controller.signal })).toBe(response);

    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ status: 500 }) }));
  });

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

  it.each([
    '/api/builds/sample/profile-inspections/latest',
    '/api/builds/sample/conversations/subject?subjectKey=finding',
    '/api/builds/sample/audits/first-look/state',
  ])('keeps the expected empty response readable without reporting an error: %s', async (path) => {
    const response = new Response('{"detail":"No result"}', {
      status: 404,
      headers: { 'X-BWorlds-Expected-State': 'empty' },
    });
    window.fetch = vi.fn().mockResolvedValue(response);
    startNetworkCapture('https://api.bworlds.co');

    const result = await fetch(`https://api.bworlds.co${path}`);

    expect(result).toBe(response);
    expect(await result.json()).toEqual({ detail: 'No result' });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it.each([
    '/api/builds/sample/profile-inspections/latest',
    '/api/builds/sample/conversations/subject?subjectKey=finding',
    '/api/builds/sample/audits/first-look/state',
    '/api/builds/sample/profile-inspections/inspection-id',
    '/api/builds/creations/creation-id/events',
    '/api/builds/missing',
    '/unrelated',
  ])('reports an unmarked 404 even on a known empty-state URL: %s', async (path) => {
    const response = new Response('Missing', { status: 404 });
    window.fetch = vi.fn().mockResolvedValue(response);
    startNetworkCapture('https://api.bworlds.co');

    expect(await fetch(`https://api.bworlds.co${path}`)).toBe(response);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ status: 404 }),
    }));
  });

  it.each([
    { status: 403, method: 'GET', marker: 'empty' },
    { status: 500, method: 'GET', marker: 'empty' },
    { status: 404, method: 'POST', marker: 'empty' },
    { status: 404, method: 'GET', marker: 'unknown' },
  ])('reports failures outside the expected empty contract: $status $method $marker', async ({ status, method, marker }) => {
    const response = new Response('Failure', {
      status,
      headers: { 'X-BWorlds-Expected-State': marker },
    });
    window.fetch = vi.fn().mockResolvedValue(response);
    startNetworkCapture('https://api.bworlds.co');

    expect(await fetch('https://api.bworlds.co/resource', { method })).toBe(response);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ status, method }),
    }));
  });

  it.each(['headers', 'get'])('still reports the response if reading %s fails', async (accessor) => {
    const response = new Response('Missing', { status: 404 });
    const fail = () => { throw new Error('Headers unavailable'); };
    if (accessor === 'headers') Object.defineProperty(response, 'headers', { get: fail });
    else vi.spyOn(response.headers, 'get').mockImplementation(fail);
    window.fetch = vi.fn().mockResolvedValue(response);
    startNetworkCapture('https://api.bworlds.co');

    expect(await fetch('https://example.com/resource')).toBe(response);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ status: 404 }),
    }));
  });

  it('reports a post-delete read with factual correlation, including a Request method', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const missing = new Response('Missing', { status: 404 });
    window.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(missing);
    startNetworkCapture('https://api.bworlds.co');

    await fetch(new Request('https://api.bworlds.co/api/builds/sample', { method: 'DELETE' }));
    vi.advanceTimersByTime(200);
    expect(await fetch('https://api.bworlds.co/api/builds/sample')).toBe(missing);

    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ status: 404, successfulDeleteAgeMs: 200 }),
    }));
  });

  it.each([
    { deleteStatus: 500, readUrl: 'https://api.bworlds.co/resource?id=1', delayMs: 200 },
    { deleteStatus: 204, readUrl: 'https://api.bworlds.co/other?id=1', delayMs: 200 },
    { deleteStatus: 204, readUrl: 'https://api.bworlds.co/resource?id=2', delayMs: 200 },
    { deleteStatus: 204, readUrl: 'https://other.example/resource?id=1', delayMs: 200 },
    { deleteStatus: 204, readUrl: 'https://api.bworlds.co/resource?id=1', delayMs: 5_001 },
  ])('keeps unrelated missing resources distinct from post-delete reads: $deleteStatus $readUrl $delayMs', async ({ deleteStatus, readUrl, delayMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const missing = new Response('Missing', { status: 404 });
    window.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(deleteStatus === 204 ? null : 'Failure', { status: deleteStatus }))
      .mockResolvedValueOnce(missing);
    startNetworkCapture('https://api.bworlds.co');

    await fetch('https://api.bworlds.co/resource?id=1', { method: 'DELETE' });
    mockEnqueue.mockClear();
    vi.advanceTimersByTime(delayMs);
    expect(await fetch(readUrl)).toBe(missing);

    const error = mockEnqueue.mock.calls[0]?.[0];
    expect(error?.metadata?.status).toBe(404);
    expect(error?.metadata).not.toHaveProperty('successfulDeleteAgeMs');
  });

  it('clears delete correlations when capture stops', async () => {
    window.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('Missing', { status: 404 }));
    startNetworkCapture('https://api.bworlds.co');
    await fetch('https://api.bworlds.co/resource', { method: 'DELETE' });
    stopNetworkCapture();
    startNetworkCapture('https://api.bworlds.co');

    expect((await fetch('https://api.bworlds.co/resource')).status).toBe(404);
    expect(mockEnqueue.mock.calls[0]?.[0].metadata).not.toHaveProperty('successfulDeleteAgeMs');
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

  it('does not capture SDK telemetry behind an endpoint path with a trailing slash', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Error', { status: 500, statusText: 'Error' }),
    );

    startNetworkCapture('https://api.bworlds.co/proxy/');
    await fetch('https://api.bworlds.co/proxy/api/telemetry/errors');

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('captures same-origin telemetry paths outside the configured endpoint base', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Error', { status: 500, statusText: 'Error' }),
    );

    startNetworkCapture('https://api.bworlds.co/proxy');
    await fetch('https://api.bworlds.co/api/telemetry/errors');

    expect(mockEnqueue).toHaveBeenCalledOnce();
  });

  it('captures product API network failures on the telemetry origin and redacts secrets', async () => {
    const failure = new TypeError('Failed to fetch');
    window.fetch = vi.fn().mockRejectedValue(failure);

    startNetworkCapture('https://api.bworlds.co');
    await expect(
      fetch('https://api.bworlds.co/api/audit-runs/123/events?accessToken=secret&after=4'),
    ).rejects.toBe(failure);

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Network error - GET https://api.bworlds.co/api/audit-runs/123/events?accessToken=%5BREDACTED%5D&after=4: Failed to fetch',
        metadata: expect.objectContaining({
          status: 0,
          requestUrl:
            'https://api.bworlds.co/api/audit-runs/123/events?accessToken=%5BREDACTED%5D&after=4',
        }),
      }),
    );
  });

  it('captures telemetry look-alike paths instead of treating them as SDK calls', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response('Error', { status: 500, statusText: 'Error' }),
    );

    startNetworkCapture('https://api.bworlds.co');
    await fetch('https://api.bworlds.co/api/telemetry-preview/errors');

    expect(mockEnqueue).toHaveBeenCalledOnce();
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
