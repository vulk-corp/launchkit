import { startSdkHealth, stopSdkHealth } from '../src/sdk-health';
import { sendTelemetry } from '../src/telemetry-sender';

vi.mock('../src/telemetry-sender', () => ({
  sendTelemetry: vi.fn(),
}));

const mockSendTelemetry = vi.mocked(sendTelemetry);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  mockSendTelemetry.mockClear();
});

afterEach(() => {
  stopSdkHealth();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('startSdkHealth / stopSdkHealth', () => {
  it('sends an immediate SDK healthcheck on start', () => {
    startSdkHealth('test-app');

    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);
    expect(mockSendTelemetry).toHaveBeenCalledWith(
      '/api/telemetry/sdk-health',
      expect.objectContaining({
        buildSlug: 'test-app',
        metadata: expect.objectContaining({ sdk_version: expect.any(String) }),
      }),
    );
  });

  it('sends subsequent healthchecks on the configured interval', () => {
    startSdkHealth('test-app', 10);

    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10_000);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(3);
  });

  it('applies light jitter to periodic healthchecks', () => {
    vi.mocked(Math.random).mockReturnValue(1);

    startSdkHealth('test-app', 10);

    vi.advanceTimersByTime(10_999);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default interval when remote config provides an invalid interval', () => {
    startSdkHealth('test-app', null);

    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(299_999);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(2);
  });

  it('stops sending after stopSdkHealth', () => {
    startSdkHealth('test-app', 10);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);

    stopSdkHealth();

    vi.advanceTimersByTime(30_000);
    expect(mockSendTelemetry).toHaveBeenCalledTimes(1);
  });
});
