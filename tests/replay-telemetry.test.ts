import { startReplayTelemetry, stopReplayTelemetry } from '../src/replay-telemetry';
import { setReplaySessionId } from '../src/session-state';
import { sendTelemetry } from '../src/telemetry-sender';

vi.mock('../src/telemetry-sender', () => ({
  sendTelemetry: vi.fn(),
}));

const mockSendTelemetry = vi.mocked(sendTelemetry);
let originalFetch: typeof fetch;
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;
let originalXhrSend: XMLHttpRequest['send'];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  mockSendTelemetry.mockClear();
  setReplaySessionId('session_123');
  originalFetch = window.fetch;
  originalConsoleLog = console.log;
  originalConsoleError = console.error;
  originalXhrSend = XMLHttpRequest.prototype.send;
});

afterEach(() => {
  stopReplayTelemetry();
  setReplaySessionId(null);
  window.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  XMLHttpRequest.prototype.send = originalXhrSend;
  vi.useRealTimers();
});

function lastTelemetryEvents(): Array<Record<string, unknown>> {
  const call = mockSendTelemetry.mock.calls[mockSendTelemetry.mock.calls.length - 1];
  const body = call?.[1] as { events?: Array<Record<string, unknown>> } | undefined;
  return body?.events ?? [];
}

describe('replay telemetry', () => {
  it('captures console methods without breaking native console behavior', () => {
    const nativeLog = vi.fn();
    console.log = nativeLog;

    startReplayTelemetry('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: true,
      networkTelemetry: false,
    });

    console.log('hello', { feature: 'replay' });
    vi.advanceTimersByTime(10_000);

    expect(nativeLog).toHaveBeenCalledWith('hello', { feature: 'replay' });
    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/replay-telemetry',
      expect.objectContaining({
        buildSlug: 'test-app',
        events: [
          expect.objectContaining({
            type: 'console',
            level: 'log',
            message: expect.stringContaining('hello'),
            sessionId: 'session_123',
            capturedAt: 1_000,
            sdkVersion: expect.any(String),
          }),
        ],
      }),
    );
  });

  it('captures fetch metadata with redacted sensitive query params and headers', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 201 }));

    startReplayTelemetry('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: false,
      networkTelemetry: true,
    });

    await fetch('https://example.com/api?token=secret&safe=value', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'x-request-id': 'req_123' },
    });
    vi.advanceTimersByTime(10_000);

    expect(lastTelemetryEvents()).toEqual([
      expect.objectContaining({
        type: 'network',
        initiator: 'fetch',
        requestType: 'fetch',
        method: 'POST',
        status: 201,
        url: 'https://example.com/api?token=%5BREDACTED%5D&safe=value',
        headers: expect.objectContaining({
          authorization: '[REDACTED]',
          'x-request-id': 'req_123',
        }),
        sessionId: 'session_123',
      }),
    ]);
  });

  it('redacts camelCase query params and token headers', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    startReplayTelemetry('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: false,
      networkTelemetry: true,
    });

    await fetch('https://example.com/api?accessToken=secret&page=2', {
      headers: { 'X-Access-Token': 'secret', Accept: 'application/json' },
    });
    vi.advanceTimersByTime(10_000);

    expect(lastTelemetryEvents()).toEqual([
      expect.objectContaining({
        url: 'https://example.com/api?accessToken=%5BREDACTED%5D&page=2',
        headers: expect.objectContaining({
          'x-access-token': '[REDACTED]',
          accept: 'application/json',
        }),
      }),
    ]);
  });

  it('does not break host fetch when the Request global is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    window.fetch = fetchMock;
    const globals = globalThis as Record<string, unknown>;
    const OriginalRequest = globals.Request;
    // A polyfilled environment can expose fetch without a Request global; the
    // wrapper must still delegate to the host fetch instead of throwing.
    delete globals.Request;

    try {
      startReplayTelemetry('test-app', 'https://api.bworlds.co', {
        consoleTelemetry: false,
        networkTelemetry: true,
      });
      const response = await fetch('https://example.com/data');
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globals.Request = OriginalRequest;
    }
  });

  it('caps deeply nested console arguments at the depth limit', () => {
    console.log = vi.fn();

    startReplayTelemetry('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: true,
      networkTelemetry: false,
    });

    // Depths 0-2 are serialized; the object at depth 3 collapses to [Object]
    // instead of the graph being walked to its leaf.
    console.log({ a: { b: { c: { d: 'deep-leaf' } } } });
    vi.advanceTimersByTime(10_000);

    const [event] = lastTelemetryEvents();
    expect(String(event?.message)).toContain('[Object]');
    expect(String(event?.message)).not.toContain('deep-leaf');
  });

  it('captures XMLHttpRequest completion without request bodies', async () => {
    XMLHttpRequest.prototype.send = vi.fn(function (this: XMLHttpRequest) {
      this.dispatchEvent(new Event('loadend'));
    });

    startReplayTelemetry('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: false,
      networkTelemetry: true,
    });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://example.com/xhr?password=secret');
    xhr.send();
    vi.advanceTimersByTime(10_000);

    expect(lastTelemetryEvents()).toEqual([
      expect.objectContaining({
        type: 'network',
        initiator: 'xmlhttprequest',
        method: 'GET',
        url: 'https://example.com/xhr?password=%5BREDACTED%5D',
        sessionId: 'session_123',
      }),
    ]);
  });

  it('rate-limits replay telemetry batches', () => {
    const nativeError = vi.fn();
    console.error = nativeError;

    startReplayTelemetry('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: true,
      networkTelemetry: false,
    });

    for (let i = 0; i < 130; i += 1) {
      console.error('event', i);
    }

    expect(nativeError).toHaveBeenCalledTimes(130);
    vi.advanceTimersByTime(10_000);

    const events = lastTelemetryEvents();
    expect(events).toHaveLength(10);
    expect(mockSendTelemetry.mock.calls).toHaveLength(12);
  });

  it("does not capture the SDK's own console output", () => {
    const nativeWarn = vi.fn();
    console.warn = nativeWarn;

    startReplayTelemetry('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: true,
      networkTelemetry: false,
    });

    console.warn('[@bworlds/launchkit] Replay chunk upload failed');
    console.warn('host warning');
    vi.advanceTimersByTime(10_000);

    const messages = lastTelemetryEvents().map((event) => String(event.message));
    expect(messages.some((m) => m.includes('host warning'))).toBe(true);
    expect(messages.some((m) => m.includes('Replay chunk upload failed'))).toBe(false);
    expect(nativeWarn).toHaveBeenCalledTimes(2);
  });

  it('serializes a shared non-circular object twice instead of marking it circular', () => {
    console.log = vi.fn();

    startReplayTelemetry('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: true,
      networkTelemetry: false,
    });

    const shared = { v: 1 };
    console.log({ a: shared, b: shared });
    vi.advanceTimersByTime(10_000);

    const message = String(lastTelemetryEvents()[0]?.message);
    expect(message).not.toContain('[Circular]');
    expect(message).toContain('"a":{"v":1}');
    expect(message).toContain('"b":{"v":1}');
  });

  it('captures requests to look-alike origins and skips only the real SDK origin', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    startReplayTelemetry('test-app', 'http://localhost:3941', {
      consoleTelemetry: false,
      networkTelemetry: true,
    });

    await fetch('http://localhost:39410/foo'); // longer port -> different origin
    await fetch('http://localhost:3941/self'); // same origin as apiEndpoint
    vi.advanceTimersByTime(10_000);

    const urls = lastTelemetryEvents().map((event) => event.url);
    expect(urls).toContain('http://localhost:39410/foo');
    expect(urls).not.toContain('http://localhost:3941/self');
  });

  it('keeps forwarding host console after telemetry stops through a retained wrapper', () => {
    const nativeLog = vi.fn();
    console.log = nativeLog;

    startReplayTelemetry('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: true,
      networkTelemetry: false,
    });
    const retained = console.log;
    stopReplayTelemetry();

    retained('after stop');
    expect(nativeLog).toHaveBeenCalledWith('after stop');
  });

  it('does not break XHR open when the host passes a non-string method', () => {
    const originalOpen = XMLHttpRequest.prototype.open;
    const nativeOpen = vi.fn();
    XMLHttpRequest.prototype.open = nativeOpen as unknown as XMLHttpRequest['open'];

    try {
      startReplayTelemetry('test-app', 'https://api.bworlds.co', {
        consoleTelemetry: false,
        networkTelemetry: true,
      });
      const xhr = new XMLHttpRequest();
      expect(() =>
        (xhr.open as unknown as (method: unknown, url: string) => void)(123, 'https://example.com/x'),
      ).not.toThrow();
      expect(nativeOpen).toHaveBeenCalled();
    } finally {
      stopReplayTelemetry();
      XMLHttpRequest.prototype.open = originalOpen;
    }
  });
});
