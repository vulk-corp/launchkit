import { startErrorCapture, stopErrorCapture, type CapturedError } from '../src/error-capture';
import { startNetworkCapture, stopNetworkCapture } from '../src/network-capture';
import { MAX_MESSAGE_LENGTH } from '../src/normalize-thrown';
import { sendTelemetry } from '../src/telemetry-sender';

// Integration pipeline: real error-capture + real network-capture, only the
// wire transport mocked. Unlike network-capture.test.ts (which mocks
// enqueueError), these tests prove the message that actually reaches the
// sender payload is string-typed, capped, and UTF-8 encodable on every path —
// the invariant whose violation drops a whole telemetry batch server-side.
vi.mock('../src/telemetry-sender', () => ({
  sendTelemetry: vi.fn(),
}));

const mockSendTelemetry = vi.mocked(sendTelemetry);

const ERROR_SOURCES = ['uncaught', 'unhandled-rejection', 'console', 'network'];

/** True when the string contains no unpaired surrogate code units. */
function isWellFormedUtf16(value: string): boolean {
  try {
    // encodeURIComponent throws URIError on lone surrogates.
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function rejectWith(reason: unknown): void {
  const event = new Event('unhandledrejection') as any;
  event.reason = reason;
  window.dispatchEvent(event);
}

/** Flush pending batches and flatten every error item sent so far. */
function flushedErrors(): CapturedError[] {
  vi.advanceTimersByTime(10_000);
  return mockSendTelemetry.mock.calls.flatMap(
    (call) => (call[1] as { errors: CapturedError[] }).errors,
  );
}

let realFetch: typeof fetch;
let realConsoleError: typeof console.error;

beforeEach(() => {
  vi.useFakeTimers();
  mockSendTelemetry.mockClear();
  realFetch = window.fetch;
  realConsoleError = console.error;
  // Silence the wrapper's call-through so oversized fixtures do not flood
  // test output; installed before startErrorCapture so the wrapper saves it.
  console.error = vi.fn();
});

afterEach(() => {
  stopErrorCapture();
  stopNetworkCapture();
  window.fetch = realFetch;
  console.error = realConsoleError;
  vi.useRealTimers();
});

describe('capture pipeline (capture path -> enqueue -> batch -> sender payload)', () => {
  it('pipeline_payload_shape: every path delivers wire-safe items in an encodable batch', async () => {
    window.fetch = vi
      .fn()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValueOnce(
        new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
      );
    startErrorCapture('pipeline-app');
    startNetworkCapture('https://api.bworlds.co');

    const circular: Record<string, unknown> = { code: 500 };
    circular.self = circular;

    window.onerror!('Uncaught [object Object]', 'test.js', 1, 1, { code: 500 } as any);
    window.onerror!('Uncaught Error: boom', 'test.js', 1, 1, new Error('boom'));
    rejectWith(circular);
    rejectWith('R'.repeat(MAX_MESSAGE_LENGTH - 1) + '\u{1F4A5}' + 'tail');
    console.error('request failed:', { code: 503 });
    await expect(fetch('https://example.com/reset')).rejects.toEqual({ code: 'ECONNRESET' });
    await fetch('https://example.com/broken');

    const errors = flushedErrors();
    expect(errors.length).toBe(7);
    for (const item of errors) {
      expect(typeof item.message).toBe('string');
      expect(item.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      expect(isWellFormedUtf16(item.message)).toBe(true);
      expect(item.message).not.toContain('[object Object]');
      expect(item.stack === null || typeof item.stack === 'string').toBe(true);
      expect(ERROR_SOURCES).toContain(item.source);
      expect(typeof item.url).toBe('string');
    }
    // The real sender JSON-stringifies the batch; every payload sent must
    // survive that without throwing.
    for (const call of mockSendTelemetry.mock.calls) {
      expect(typeof JSON.stringify(call[1])).toBe('string');
    }
  });

  it('network_prefix_truncation: prefixed network message is cut to the cap, prefix intact', async () => {
    const reason = { message: 'M'.repeat(MAX_MESSAGE_LENGTH + 1000) };
    window.fetch = vi.fn().mockRejectedValue(reason);
    startErrorCapture('pipeline-app');
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/flaky')).rejects.toBe(reason);

    const [item] = flushedErrors();
    const prefix = 'Network error - GET https://example.com/flaky: ';
    expect(item.message.length).toBe(MAX_MESSAGE_LENGTH);
    expect(item.message.startsWith(prefix)).toBe(true);
    expect(item.message).toBe((prefix + reason.message).slice(0, MAX_MESSAGE_LENGTH));
  });

  it('network_prefix_surrogate_boundary: pair straddling the post-prefix cut is dropped whole', async () => {
    const prefix = 'Network error - GET https://example.com/flaky: ';
    // Position the emoji's surrogate pair across the cap of the combined
    // prefixed string: high surrogate at index 4999, low at 5000.
    const filler = 'B'.repeat(MAX_MESSAGE_LENGTH - prefix.length - 1);
    const reason = { message: filler + '\u{1F4A5}' + 'tail' };
    window.fetch = vi.fn().mockRejectedValue(reason);
    startErrorCapture('pipeline-app');
    startNetworkCapture('https://api.bworlds.co');

    await expect(fetch('https://example.com/flaky')).rejects.toBe(reason);

    const [item] = flushedErrors();
    expect(item.message.length).toBe(MAX_MESSAGE_LENGTH - 1);
    expect(isWellFormedUtf16(item.message)).toBe(true);
  });

  it('onerror_oversized_truncated: oversized browser message on the onerror path is capped', () => {
    startErrorCapture('pipeline-app');

    window.onerror!('E'.repeat(12_000), 'test.js', 1, 1, undefined);

    const [item] = flushedErrors();
    expect(item.message.length).toBe(MAX_MESSAGE_LENGTH);
    expect(item.source).toBe('uncaught');
  });

  it('console_oversized_truncated: oversized console args are capped and surrogate-safe', () => {
    startErrorCapture('pipeline-app');

    console.error('C'.repeat(MAX_MESSAGE_LENGTH - 1) + '\u{1F4A5}' + 'tail');
    console.error({ detail: 'D'.repeat(MAX_MESSAGE_LENGTH + 1000) });

    const errors = flushedErrors();
    expect(errors.length).toBe(2);
    expect(errors[0].message.length).toBe(MAX_MESSAGE_LENGTH - 1);
    expect(isWellFormedUtf16(errors[0].message)).toBe(true);
    expect(errors[1].message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(errors[1].message.startsWith('{"detail":"DDD')).toBe(true);
  });

  it('interior_lone_surrogate: a lone surrogate inside a short message ships encodable', () => {
    startErrorCapture('pipeline-app');

    rejectWith('user said \uD83D');

    const [item] = flushedErrors();
    expect(item.message).toBe('user said \uFFFD');
    expect(isWellFormedUtf16(item.message)).toBe(true);
  });

  it('oversized_stack_and_url: stack and url are capped at the chokepoint on the wire', () => {
    startErrorCapture('pipeline-app');

    const err = new Error('deep stack');
    Object.defineProperty(err, 'stack', { value: 'at frame\n'.repeat(2_000) });
    window.onerror!('deep stack', 'https://example.com/' + 'p'.repeat(3_000), 1, 1, err);

    const [item] = flushedErrors();
    expect(item.stack!.length).toBe(10_000);
    expect(item.url!.length).toBe(2_048);
    expect(typeof JSON.stringify(mockSendTelemetry.mock.calls[0][1])).toBe('string');
  });

  it('restart_recaptures: stop/start re-registers handlers and normalization still applies', async () => {
    const reason = { message: 'net after restart' };
    window.fetch = vi.fn().mockRejectedValue(reason);
    startErrorCapture('pipeline-app');
    startNetworkCapture('https://api.bworlds.co');

    rejectWith({ code: 500 });
    stopErrorCapture();
    stopNetworkCapture();
    expect(flushedErrors().map((e) => e.message)).toEqual(['{"code":500}']);
    mockSendTelemetry.mockClear();

    startErrorCapture('pipeline-app');
    startNetworkCapture('https://api.bworlds.co');

    rejectWith({ error: 'after restart' });
    window.onerror!('Uncaught [object Object]', 'test.js', 1, 1, { code: 410 } as any);
    await expect(fetch('https://example.com/flaky')).rejects.toBe(reason);

    const messages = flushedErrors().map((e) => e.message);
    expect(messages).toEqual([
      'after restart',
      '{"code":410}',
      'Network error - GET https://example.com/flaky: net after restart',
    ]);
  });
});
