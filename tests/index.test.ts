import { init, stop } from '../src/index';
import { configureSender } from '../src/telemetry-sender';
import { startHeartbeat, stopHeartbeat } from '../src/heartbeat';
import { startErrorCapture, stopErrorCapture } from '../src/error-capture';
import { check } from '../src/check';
import { fetchRemoteConfig } from '../src/remote-config';

vi.mock('../src/telemetry-sender', () => ({
  configureSender: vi.fn(),
  sendTelemetry: vi.fn(),
}));

vi.mock('../src/heartbeat', () => ({
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
}));

vi.mock('../src/error-capture', () => ({
  startErrorCapture: vi.fn(),
  stopErrorCapture: vi.fn(),
}));

vi.mock('../src/check', () => ({
  check: vi.fn().mockResolvedValue({ valid: true, email: null, accessType: 'free', expiresAt: null, degraded: false }),
}));

vi.mock('../src/replay', () => ({
  startReplay: vi.fn().mockResolvedValue(undefined),
  stopReplay: vi.fn(),
}));

vi.mock('../src/remote-config', () => ({
  fetchRemoteConfig: vi.fn().mockResolvedValue(null),
}));

const mockFetchRemoteConfig = vi.mocked(fetchRemoteConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchRemoteConfig.mockResolvedValue(null);
});

describe('init()', () => {
  it('calls configureSender with buildSlug and apiEndpoint', () => {
    init({ buildSlug: 'test-app', apiEndpoint: 'https://custom.api' });

    expect(configureSender).toHaveBeenCalledWith({
      buildSlug: 'test-app',
      apiEndpoint: 'https://custom.api',
    });
  });

  it('starts heartbeat by default', () => {
    init({ buildSlug: 'test-app' });
    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
  });

  it('starts error capture by default', () => {
    init({ buildSlug: 'test-app' });
    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
  });

  it('fetches remote config', () => {
    init({ buildSlug: 'test-app' });
    expect(mockFetchRemoteConfig).toHaveBeenCalledWith('https://api.bworlds.co', 'test-app');
  });

  it('stops heartbeat when remote config disables monitoring', async () => {
    mockFetchRemoteConfig.mockResolvedValue({ monitoring: false, sessionReplay: true });

    init({ buildSlug: 'test-app' });
    await vi.waitFor(() => {
      expect(stopHeartbeat).toHaveBeenCalled();
    });
  });

  it('stops error capture and replay when remote config disables sessionReplay', async () => {
    mockFetchRemoteConfig.mockResolvedValue({ monitoring: true, sessionReplay: false });

    init({ buildSlug: 'test-app' });
    await vi.waitFor(() => {
      expect(stopErrorCapture).toHaveBeenCalled();
    });
  });

  it('keeps everything running when remote config fetch fails', async () => {
    mockFetchRemoteConfig.mockResolvedValue(null);

    init({ buildSlug: 'test-app' });

    // Let promises settle
    await new Promise((r) => setTimeout(r, 0));

    expect(stopHeartbeat).not.toHaveBeenCalled();
    expect(stopErrorCapture).not.toHaveBeenCalled();
  });
});

describe('LaunchKitInstance', () => {
  it('check() delegates to the check module', async () => {
    const instance = init({ buildSlug: 'test-app' });
    await instance.check();

    expect(check).toHaveBeenCalledWith('test-app', 'https://api.bworlds.co');
  });

  it('getGateUrl() returns the correct URL', () => {
    const instance = init({ buildSlug: 'my-app' });
    expect(instance.getGateUrl()).toBe('https://app.bworlds.co/access/my-app');
  });

  it('stop() calls stopHeartbeat and stopErrorCapture', () => {
    const instance = init({ buildSlug: 'test-app' });
    instance.stop();

    expect(stopHeartbeat).toHaveBeenCalled();
    expect(stopErrorCapture).toHaveBeenCalled();
  });
});

describe('top-level stop()', () => {
  it('calls stopHeartbeat and stopErrorCapture', () => {
    init({ buildSlug: 'test-app' });
    stop();

    expect(stopHeartbeat).toHaveBeenCalled();
    expect(stopErrorCapture).toHaveBeenCalled();
  });
});
