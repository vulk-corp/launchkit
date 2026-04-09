import { startErrorCapture, stopErrorCapture } from '../src/error-capture';
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

  it('captures errors via window.onerror and flushes on timer', () => {
    startErrorCapture('test-app');

    window.onerror!('Test error', 'test.js', 1, 1, new Error('Test error'));

    expect(mockSendTelemetry).not.toHaveBeenCalled(); // not yet (below threshold)

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        buildSlug: 'test-app',
        errors: [expect.objectContaining({ message: 'Test error' })],
      }),
    );
  });

  it('captures unhandledrejection events', () => {
    startErrorCapture('test-app');

    const event = new Event('unhandledrejection') as any;
    event.reason = new Error('Promise rejected');
    window.dispatchEvent(event);

    vi.advanceTimersByTime(10_000);

    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/errors',
      expect.objectContaining({
        errors: [expect.objectContaining({ message: 'Promise rejected' })],
      }),
    );
  });

  it('flushes immediately when batch threshold (5) is reached', () => {
    startErrorCapture('test-app');

    for (let i = 0; i < 5; i++) {
      window.onerror!(`Error ${i}`, 'test.js', 1, 1, new Error(`Error ${i}`));
    }

    // Should flush without waiting for timer
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
