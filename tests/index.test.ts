import { init, stop } from '../src/index';
import { configureSender } from '../src/telemetry-sender';
import { startHeartbeat, stopHeartbeat } from '../src/heartbeat';
import { startErrorCapture, stopErrorCapture } from '../src/error-capture';
import { check } from '../src/check';

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

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(startHeartbeat).toHaveBeenCalledWith('test-app', undefined);
  });

  it('starts error capture by default', () => {
    init({ buildSlug: 'test-app' });
    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
  });

  it('skips heartbeat when enableHeartbeat: false', () => {
    init({ buildSlug: 'test-app', enableHeartbeat: false });
    expect(startHeartbeat).not.toHaveBeenCalled();
  });

  it('skips error capture when enableErrorCapture: false', () => {
    init({ buildSlug: 'test-app', enableErrorCapture: false });
    expect(startErrorCapture).not.toHaveBeenCalled();
  });

  it('passes custom heartbeat interval', () => {
    init({ buildSlug: 'test-app', heartbeatInterval: 60_000 });
    expect(startHeartbeat).toHaveBeenCalledWith('test-app', 60_000);
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
