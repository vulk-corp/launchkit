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
  document.getElementById('bworlds-gate-overlay')?.remove();
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

describe('gate overlay', () => {
  it('shows overlay during access check', async () => {
    init({ buildSlug: 'test-app' });

    // Overlay should be in the DOM while check is pending
    expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();

    // Let the check() promise resolve (mocked as valid)
    await vi.waitFor(() => {
      expect(document.getElementById('bworlds-gate-overlay')).toBeNull();
    });
  });

  it('removes overlay when check returns valid', async () => {
    vi.mocked(check).mockResolvedValueOnce({
      valid: true, email: null, accessType: 'paid', expiresAt: null, degraded: false,
    });

    init({ buildSlug: 'test-app' });
    expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();

    await vi.waitFor(() => {
      expect(document.getElementById('bworlds-gate-overlay')).toBeNull();
    });
  });

  it('keeps overlay when redirecting (invalid check)', async () => {
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost/' },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window.location, 'href', {
      set: hrefSetter,
      get: () => 'http://localhost/',
      configurable: true,
    });

    vi.mocked(check).mockResolvedValueOnce({
      valid: false, email: null, accessType: null, expiresAt: null, degraded: false,
    });

    init({ buildSlug: 'test-app' });

    // Wait for the promise to settle
    await new Promise((r) => setTimeout(r, 10));

    // Overlay stays in DOM during redirect
    expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();
    expect(hrefSetter).toHaveBeenCalledWith('https://app.bworlds.co/access/test-app');
  });

  it('does not show overlay when gate is disabled', () => {
    init({ buildSlug: 'test-app', gate: false });
    expect(document.getElementById('bworlds-gate-overlay')).toBeNull();
  });
});
