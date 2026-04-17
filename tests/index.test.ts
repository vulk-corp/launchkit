import { init, stop } from '../src/index';
import { configureSender } from '../src/telemetry-sender';
import { startHeartbeat, stopHeartbeat } from '../src/heartbeat';
import { startErrorCapture, stopErrorCapture } from '../src/error-capture';
import { check } from '../src/check';
import { fetchRemoteConfig } from '../src/remote-config';
import { startBadgeWidget } from '../src/badge-widget';

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

vi.mock('../src/badge-widget', () => ({
  startBadgeWidget: vi.fn().mockResolvedValue(undefined),
  stopBadgeWidget: vi.fn(),
}));

const mockFetchRemoteConfig = vi.mocked(fetchRemoteConfig);

beforeEach(() => {
  vi.clearAllMocks();
  document.getElementById('bworlds-gate-overlay')?.remove();
  mockFetchRemoteConfig.mockResolvedValue(null);
});

describe('init()', () => {
  it('calls configureSender with buildSlug and apiEndpoint', () => {
    init({ buildSlug: 'test-app', apiEndpoint: 'https://custom.api', gate: false });

    expect(configureSender).toHaveBeenCalledWith({
      buildSlug: 'test-app',
      apiEndpoint: 'https://custom.api',
    });
  });

  it('starts heartbeat by default', () => {
    init({ buildSlug: 'test-app', gate: false });
    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
  });

  it('starts error capture by default', () => {
    init({ buildSlug: 'test-app', gate: false });
    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
  });

  it('fetches remote config', () => {
    init({ buildSlug: 'test-app', gate: false });
    expect(mockFetchRemoteConfig).toHaveBeenCalledWith('https://api.bworlds.co', 'test-app');
  });

  it('stops heartbeat when remote config disables monitoring', async () => {
    mockFetchRemoteConfig.mockResolvedValue({ monitoring: false, sessionReplay: true, badge: false });

    init({ buildSlug: 'test-app', gate: false });
    await vi.waitFor(() => {
      expect(stopHeartbeat).toHaveBeenCalled();
    });
  });

  it('stops error capture and replay when remote config disables sessionReplay', async () => {
    mockFetchRemoteConfig.mockResolvedValue({ monitoring: true, sessionReplay: false, badge: false });

    init({ buildSlug: 'test-app', gate: false });
    await vi.waitFor(() => {
      expect(stopErrorCapture).toHaveBeenCalled();
    });
  });

  it('keeps everything running when remote config fetch fails', async () => {
    mockFetchRemoteConfig.mockResolvedValue(null);

    init({ buildSlug: 'test-app', gate: false });

    // Let promises settle
    await new Promise((r) => setTimeout(r, 0));

    expect(stopHeartbeat).not.toHaveBeenCalled();
    expect(stopErrorCapture).not.toHaveBeenCalled();
  });

  it('starts the badge widget when remote config enables badge', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: true,
    });

    init({ buildSlug: 'test-app', gate: false });

    await vi.waitFor(() => {
      expect(startBadgeWidget).toHaveBeenCalledWith(
        'test-app',
        'https://api.bworlds.co',
        'https://app.bworlds.co'
      );
    });
  });

  it('does not start the badge widget when remote config disables badge', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: false,
    });

    init({ buildSlug: 'test-app', gate: false });

    await new Promise((r) => setTimeout(r, 0));

    expect(startBadgeWidget).not.toHaveBeenCalled();
  });
});

describe('LaunchKitInstance', () => {
  it('check() delegates to the check module', async () => {
    const instance = init({ buildSlug: 'test-app', gate: false });
    await instance.check();

    expect(check).toHaveBeenCalledWith('test-app', 'https://api.bworlds.co');
  });

  it('getGateUrl() returns the correct URL', () => {
    const instance = init({ buildSlug: 'my-app', gate: false });
    expect(instance.getGateUrl()).toBe('https://app.bworlds.co/access/my-app');
  });

  it('getGateUrl() uses the gateOrigin override when provided', () => {
    const instance = init({
      buildSlug: 'my-app',
      gateOrigin: 'http://localhost:3939',
      gate: false,
    });
    expect(instance.getGateUrl()).toBe('http://localhost:3939/access/my-app');
  });

  it('getGateUrl() falls back to the default origin when gateOrigin is omitted on re-init', () => {
    init({ buildSlug: 'my-app', gateOrigin: 'http://localhost:3939', gate: false });
    const instance = init({ buildSlug: 'my-app', gate: false });
    expect(instance.getGateUrl()).toBe('https://app.bworlds.co/access/my-app');
  });

  it('stop() calls stopHeartbeat and stopErrorCapture', () => {
    const instance = init({ buildSlug: 'test-app', gate: false });
    instance.stop();

    expect(stopHeartbeat).toHaveBeenCalled();
    expect(stopErrorCapture).toHaveBeenCalled();
  });
});

describe('top-level stop()', () => {
  it('calls stopHeartbeat and stopErrorCapture', () => {
    init({ buildSlug: 'test-app', gate: false });
    stop();

    expect(stopHeartbeat).toHaveBeenCalled();
    expect(stopErrorCapture).toHaveBeenCalled();
  });
});

describe('gate overlay', () => {
  it('shows overlay during access check', async () => {
    init({ buildSlug: 'test-app' });

    expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();

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

    await new Promise((r) => setTimeout(r, 10));

    expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();
    expect(hrefSetter).toHaveBeenCalledWith('https://app.bworlds.co/access/test-app');
  });

  it('built-in gate redirects to the gateOrigin override when provided', async () => {
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
      valid: false,
      email: null,
      accessType: null,
      expiresAt: null,
      degraded: false,
    });

    init({ buildSlug: 'test-app', gateOrigin: 'http://localhost:3939' });

    await new Promise((r) => setTimeout(r, 10));

    expect(hrefSetter).toHaveBeenCalledWith('http://localhost:3939/access/test-app');
  });

  it('does not show overlay when gate is disabled', () => {
    init({ buildSlug: 'test-app', gate: false });
    expect(document.getElementById('bworlds-gate-overlay')).toBeNull();
  });
});
