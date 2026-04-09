import { startHeartbeat, stopHeartbeat } from '../src/heartbeat';
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
  stopHeartbeat();
  vi.useRealTimers();
});

describe('startHeartbeat / stopHeartbeat', () => {
  it('sends an immediate heartbeat on start', () => {
    startHeartbeat('test-app');

    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);
    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/heartbeat',
      { buildSlug: 'test-app' },
    );
  });

  it('sends subsequent heartbeats on the configured interval', () => {
    startHeartbeat('test-app', 10_000);

    expect(mockSendTelemetry).toHaveBeenCalledTimes(1); // immediate

    vi.advanceTimersByTime(10_000);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10_000);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(3);
  });

  it('stops sending after stopHeartbeat', () => {
    startHeartbeat('test-app', 10_000);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);

    stopHeartbeat();

    vi.advanceTimersByTime(30_000);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(1); // no more calls
  });

  it('prevents double-install', () => {
    startHeartbeat('test-app', 10_000);
    startHeartbeat('test-app', 10_000); // second call should be ignored

    expect(mockSendTelemetry).toHaveBeenCalledTimes(1); // only one immediate heartbeat
  });
});
