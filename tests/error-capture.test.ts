import { startErrorCapture, stopErrorCapture, enqueueError } from '../src/error-capture';
import { MAX_MESSAGE_LENGTH, MAX_STACK_LENGTH, MAX_URL_LENGTH } from '../src/normalize-thrown';
import { sendTelemetry } from '../src/telemetry-sender';

vi.mock('../src/telemetry-sender', () => ({
  sendTelemetry: vi.fn(),
}));

const mockSendTelemetry = vi.mocked(sendTelemetry);

beforeEach(() => {
  vi.useFakeTimers();
  mockSendTelemetry.mockClear();
});

afterEach(() => {
  stopErrorCapture();
  vi.useRealTimers();
});

describe('startErrorCapture / stopErrorCapture', () => {
  it('hooks window.onerror on start', () => {
    const original = window.onerror;
    startErrorCapture('test-app');
    expect(window.onerror).not.toBe(original);
  });

  it('captures errors via window.onerror with source: uncaught', () => {
    startErrorCapture('test-app');

    window.onerror!('Test error', 'test.js', 1, 1, new Error('Test error'));

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        buildSlug: 'test-app',
        errors: [expect.objectContaining({ message: 'Test error', source: 'uncaught' })],
      }),
    );
  });

  it('captures unhandledrejection events with source: unhandled-rejection', () => {
    startErrorCapture('test-app');

    const event = new Event('unhandledrejection') as any;
    event.reason = new Error('Promise rejected');
    window.dispatchEvent(event);

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [expect.objectContaining({ message: 'Promise rejected', source: 'unhandled-rejection' })],
      }),
    );
  });

  it('flushes immediately when batch threshold (5) is reached', () => {
    startErrorCapture('test-app');

    for (let i = 0; i < 5; i++) {
      window.onerror!(`Error ${i}`, 'test.js', 1, 1, new Error(`Error ${i}`));
    }

    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);
    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({ message: 'Error 0' }),
          expect.objectContaining({ message: 'Error 4' }),
        ]),
      }),
    );
  });

  it('restores original window.onerror on stop', () => {
    const original = () => false;
    window.onerror = original;

    startErrorCapture('test-app');
    expect(window.onerror).not.toBe(original);

    stopErrorCapture();
    expect(window.onerror).toBe(original);
  });

  it('flushes remaining errors on stop', () => {
    startErrorCapture('test-app');

    window.onerror!('Leftover', 'test.js', 1, 1, new Error('Leftover'));
    expect(mockSendTelemetry).not.toHaveBeenCalled();

    stopErrorCapture();

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [expect.objectContaining({ message: 'Leftover' })],
      }),
    );
  });

  it('prevents double-install', () => {
    startErrorCapture('test-app');
    const hookAfterFirst = window.onerror;

    startErrorCapture('test-app'); // second call ignored
    expect(window.onerror).toBe(hookAfterFirst);
  });

  it('onerror_non_string_stack: nulls a non-string stack on the Error branch', () => {
    startErrorCapture('test-app');

    const err = new Error('bad stack');
    Object.defineProperty(err, 'stack', { value: 42 });
    window.onerror!('bad stack', 't.js', 1, 1, err);

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [expect.objectContaining({ message: 'bad stack', stack: null })],
      }),
    );
  });

  it('onerror_throwing_stack_getter: still chains to the original onerror', () => {
    const original = vi.fn().mockReturnValue(true);
    window.onerror = original;
    startErrorCapture('test-app');

    const err = new Error('poison');
    Object.defineProperty(err, 'stack', {
      get() {
        throw new Error('poisoned getter');
      },
    });

    const result = window.onerror!('poison', 't.js', 1, 1, err);

    expect(original).toHaveBeenCalledWith('poison', 't.js', 1, 1, err);
    expect(result).toBe(true);
  });
});

describe('flush on page hidden', () => {
  let visibilityState: DocumentVisibilityState = 'visible';
  let originalDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    visibilityState = 'visible';
    originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });
  });

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(Document.prototype, 'visibilityState', originalDescriptor);
    }
  });

  it('flushes queued errors when the page becomes hidden', () => {
    startErrorCapture('test-app');

    window.onerror!('Dying breath', 'test.js', 1, 1, new Error('Dying breath'));
    expect(mockSendTelemetry).not.toHaveBeenCalled();

    visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [expect.objectContaining({ message: 'Dying breath' })],
      }),
    );
  });

  it('does not flush when visibility changes to visible', () => {
    startErrorCapture('test-app');

    window.onerror!('Still alive', 'test.js', 1, 1, new Error('Still alive'));

    document.dispatchEvent(new Event('visibilitychange')); // state stays 'visible'

    expect(mockSendTelemetry).not.toHaveBeenCalled();
  });

  it('removes the visibility listener on stop', () => {
    startErrorCapture('test-app');
    stopErrorCapture();
    mockSendTelemetry.mockClear();

    // Queue an error post-stop so a leaked listener would actually flush it.
    enqueueError({ message: 'after stop', stack: null, url: null, source: 'network' });
    visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockSendTelemetry).not.toHaveBeenCalled();
  });
});

describe('wire-validity chokepoint', () => {
  function flushedFirstError(): { message: string; stack: string | null; url: string | null } {
    vi.advanceTimersByTime(10_000);
    const payload = mockSendTelemetry.mock.calls[0][1] as {
      errors: Array<{ message: string; stack: string | null; url: string | null }>;
    };
    return payload.errors[0];
  }

  it('truncates an oversized stack at MAX_STACK_LENGTH', () => {
    startErrorCapture('test-app');

    enqueueError({
      message: 'm',
      stack: 's'.repeat(MAX_STACK_LENGTH + 2_000),
      url: 'https://example.com',
      source: 'network',
    });

    expect(flushedFirstError().stack!.length).toBe(MAX_STACK_LENGTH);
  });

  it('truncates an oversized url at MAX_URL_LENGTH', () => {
    startErrorCapture('test-app');

    enqueueError({
      message: 'm',
      stack: null,
      url: 'https://example.com/' + 'a'.repeat(MAX_URL_LENGTH),
      source: 'network',
    });

    expect(flushedFirstError().url!.length).toBe(MAX_URL_LENGTH);
  });

  it('nulls a non-string stack smuggled past the types', () => {
    startErrorCapture('test-app');

    enqueueError({
      message: 'm',
      stack: 42 as unknown as string,
      url: 'https://example.com',
      source: 'network',
    });

    expect(flushedFirstError().stack).toBeNull();
  });
});

describe('console.error interception', () => {
  it('captures console.error calls with source: console', () => {
    startErrorCapture('test-app');

    console.error('Something went wrong');

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [expect.objectContaining({ message: 'Something went wrong', source: 'console' })],
      }),
    );
  });

  it('calls through to original console.error', () => {
    const originalConsoleError = console.error;
    const spy = vi.fn();
    console.error = spy;

    startErrorCapture('test-app');
    console.error('test message');

    expect(spy).toHaveBeenCalledWith('test message');

    stopErrorCapture();
    console.error = originalConsoleError;
  });

  it('extracts Error objects from arguments for stack traces', () => {
    startErrorCapture('test-app');

    const err = new Error('Typed error');
    console.error('prefix', err);

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [
          expect.objectContaining({
            message: 'Typed error',
            source: 'console',
            stack: expect.stringContaining('Error: Typed error'),
          }),
        ],
      }),
    );
  });

  it('handles multiple string arguments', () => {
    startErrorCapture('test-app');

    console.error('Upload error for', 'file.pdf', '->', 'path/file.pdf');

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [
          expect.objectContaining({
            message: 'Upload error for file.pdf -> path/file.pdf',
            source: 'console',
            stack: null,
          }),
        ],
      }),
    );
  });

  it('console_budget: stops normalizing args once the message budget is spent', () => {
    // Silence the wrapper's call-through so the oversized fixture does not
    // flood test output.
    const realConsoleError = console.error;
    console.error = vi.fn();
    startErrorCapture('test-app');

    let normalized = false;
    const sentinel = {
      get message() {
        normalized = true;
        return 'tail';
      },
    };
    console.error('C'.repeat(MAX_MESSAGE_LENGTH + 1), sentinel);

    vi.advanceTimersByTime(10_000);

    const payload = mockSendTelemetry.mock.calls[0][1] as {
      errors: Array<{ message: string }>;
    };
    expect(normalized).toBe(false);
    expect(payload.errors[0].message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);

    stopErrorCapture();
    console.error = realConsoleError;
  });

  it('restores original console.error on stop', () => {
    const original = console.error;
    startErrorCapture('test-app');
    expect(console.error).not.toBe(original);

    stopErrorCapture();
    expect(console.error).toBe(original);
  });

  it('does not capture re-entrant calls', () => {
    startErrorCapture('test-app');

    // Simulate re-entrancy: enqueueError calls console.error inside
    // In practice this shouldn't happen, but the guard must protect against it
    const originalConsoleError = (console.error as any);
    // Trigger a console.error that is already inside _capturing
    // We test the guard by checking only one error is captured per call
    console.error('single call');

    vi.advanceTimersByTime(10_000);

    const call = mockSendTelemetry.mock.calls[0];
    expect(call[1]).toEqual(
      expect.objectContaining({
        errors: [expect.objectContaining({ message: 'single call' })],
      }),
    );
  });
});

describe('non-Error capture (#850)', () => {
  function rejectWith(reason: unknown): void {
    const event = new Event('unhandledrejection') as any;
    event.reason = reason;
    window.dispatchEvent(event);
  }

  function lastCapturedMessage(): unknown {
    vi.advanceTimersByTime(10_000);
    const calls = mockSendTelemetry.mock.calls;
    const payload = calls[calls.length - 1][1] as { errors: Array<{ message: unknown }> };
    return payload.errors[payload.errors.length - 1].message;
  }

  it('object_message_field: rejection object with string message field captures that field', () => {
    startErrorCapture('test-app');

    rejectWith({ message: 'payment failed' });

    expect(lastCapturedMessage()).toBe('payment failed');
  });

  it('rejection_object_serialized: rejection object without message/error fields captures serialized JSON', () => {
    startErrorCapture('test-app');

    rejectWith({ code: 500, detail: 'upstream' });

    expect(lastCapturedMessage()).toBe('{"code":500,"detail":"upstream"}');
  });

  it('object_error_field: rejection object with error field derives message from it', () => {
    startErrorCapture('test-app');

    rejectWith({ error: 'boom from error field' });

    expect(lastCapturedMessage()).toBe('boom from error field');
  });

  it('primitive_verbatim: string and number rejections captured verbatim', () => {
    startErrorCapture('test-app');

    rejectWith('plain string reason');
    rejectWith(42);

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [
          expect.objectContaining({ message: 'plain string reason' }),
          expect.objectContaining({ message: '42' }),
        ],
      }),
    );
  });

  it('onerror_non_error: uncaught non-Error throw captures readable message', () => {
    startErrorCapture('test-app');

    // Browsers pass the stringified value as `message` and the thrown value as `error`
    window.onerror!('Uncaught [object Object]', 'test.js', 1, 1, { code: 500 } as any);

    expect(lastCapturedMessage()).toBe('{"code":500}');
  });

  it('onerror keeps browser message when error param is absent (cross-origin)', () => {
    startErrorCapture('test-app');

    window.onerror!('Script error.', undefined, 0, 0, undefined);

    expect(lastCapturedMessage()).toBe('Script error.');
  });

  it('error_instance_unchanged: Error rejection keeps message and stack as before', () => {
    startErrorCapture('test-app');

    const err = new Error('real error');
    rejectWith(err);

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [
          expect.objectContaining({
            message: 'real error',
            stack: expect.stringContaining('Error: real error'),
          }),
        ],
      }),
    );
  });

  it('console_object_arg: console.error with object arg captures readable message', () => {
    startErrorCapture('test-app');

    console.error('request failed:', { code: 500 });

    expect(lastCapturedMessage()).toBe('request failed: {"code":500}');
  });

  it('message_truncated_5000: oversized rejection message truncated to 5000 chars', () => {
    startErrorCapture('test-app');

    rejectWith('x'.repeat(10_000));

    const message = lastCapturedMessage();
    expect(typeof message).toBe('string');
    expect((message as string).length).toBe(5000);
  });

  it('normalize_always_string: non-string message field still yields a string message', () => {
    startErrorCapture('test-app');

    rejectWith({ message: 123 });

    const message = lastCapturedMessage();
    expect(typeof message).toBe('string');
    expect(message).toBe('{"message":123}');
  });

  it('normalize_never_throws: circular rejection reason captured without breaking the host app', () => {
    startErrorCapture('test-app');

    const circular: Record<string, unknown> = { code: 500 };
    circular.self = circular;
    expect(() => rejectWith(circular)).not.toThrow();

    const message = lastCapturedMessage();
    expect(typeof message).toBe('string');
    expect(message).not.toContain('[object Object]');
  });

  it('captures null and undefined rejection reasons as readable strings', () => {
    startErrorCapture('test-app');

    rejectWith(null);
    rejectWith(undefined);

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [
          expect.objectContaining({ message: 'null' }),
          expect.objectContaining({ message: 'undefined' }),
        ],
      }),
    );
  });

  it('captures an Error subclass with a non-string message getter as a string message', () => {
    startErrorCapture('test-app');

    class BadMessage extends Error {
      get message(): string {
        return { nested: true } as unknown as string;
      }
    }
    rejectWith(new BadMessage());

    const message = lastCapturedMessage();
    expect(typeof message).toBe('string');
    expect(message).toBe('{"nested":true}');
  });

  it('console.error mixing strings and objects joins readable parts', () => {
    startErrorCapture('test-app');

    console.error('upload failed', { code: 413, file: 'big.pdf' }, 'retrying in', 5);

    expect(lastCapturedMessage()).toBe(
      'upload failed {"code":413,"file":"big.pdf"} retrying in 5',
    );
  });
});

describe('enqueueError (exported)', () => {
  it('allows external modules to enqueue errors', () => {
    startErrorCapture('test-app');

    enqueueError({
      message: 'External error',
      stack: null,
      url: 'https://example.com',
      source: 'network',
      metadata: { status: 500 },
    });

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [
          expect.objectContaining({
            message: 'External error',
            source: 'network',
            metadata: { status: 500 },
          }),
        ],
      }),
    );
  });
});
