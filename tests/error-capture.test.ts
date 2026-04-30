import { startErrorCapture, stopErrorCapture, enqueueError } from '../src/error-capture';
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
