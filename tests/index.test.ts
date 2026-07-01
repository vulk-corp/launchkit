import { init, stop } from '../src/index';
import { configureSender } from '../src/telemetry-sender';
import { startHeartbeat, stopHeartbeat } from '../src/heartbeat';
import { startErrorCapture, stopErrorCapture } from '../src/error-capture';
import { check } from '../src/check';
import type { CheckResult } from '../src/check';
import { fetchRemoteConfig, readCachedGatingEnabled } from '../src/remote-config';
import { startBadgeWidget } from '../src/badge-widget';
import { startReplay } from '../src/replay';
import { startReplayTelemetry } from '../src/replay-telemetry';
import { setReplaySessionId } from '../src/session-state';

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

vi.mock('../src/replay', async () => {
  const { setReplaySessionId: publishSession } =
    await vi.importActual<typeof import('../src/session-state')>('../src/session-state');
  return {
    // Real startReplay publishes the session id once rrweb records; mirror that so
    // index only wires console/network telemetry when a session is actually live.
    startReplay: vi.fn(async () => {
      publishSession('replay-session-test');
    }),
    stopReplay: vi.fn(),
  };
});

vi.mock('../src/replay-telemetry', () => ({
  startReplayTelemetry: vi.fn(),
  stopReplayTelemetry: vi.fn(),
}));

vi.mock('../src/remote-config', () => ({
  fetchRemoteConfig: vi.fn().mockResolvedValue(null),
  // Default: cold cache -> gating enabled -> overlay mounts (fail-safe).
  // Tests that need ungated behavior can override per-test.
  readCachedGatingEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/badge-widget', () => ({
  startBadgeWidget: vi.fn().mockResolvedValue(undefined),
  stopBadgeWidget: vi.fn(),
}));

vi.mock('../src/network-capture', () => ({
  startNetworkCapture: vi.fn(),
  stopNetworkCapture: vi.fn(),
}));

vi.mock('../src/supabase-identity-bridge', () => ({
  startSupabaseIdentityBridge: vi.fn(),
  stopSupabaseIdentityBridge: vi.fn(),
  connectSupabase: vi.fn(),
}));

const mockFetchRemoteConfig = vi.mocked(fetchRemoteConfig);
const mockReadCachedGatingEnabled = vi.mocked(readCachedGatingEnabled);

beforeEach(() => {
  // Reset SDK state so _initialized is false for each test.
  stop();
  vi.clearAllMocks();
  setReplaySessionId(null);
  document.getElementById('bworlds-gate-overlay')?.remove();
  mockFetchRemoteConfig.mockResolvedValue(null);
  // Default: cold cache -> gating enabled -> overlay mounts (fail-safe).
  mockReadCachedGatingEnabled.mockReturnValue(true);
});

/** Flush microtask queue so the deferred activation in init() completes. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('init()', () => {
  it('calls configureSender with buildSlug and apiEndpoint', () => {
    init({ buildSlug: 'test-app', apiEndpoint: 'https://custom.api', gate: false });

    expect(configureSender).toHaveBeenCalledWith({
      buildSlug: 'test-app',
      apiEndpoint: 'https://custom.api',
    });
  });

  it('starts heartbeat by default after config fetch resolves', async () => {
    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();
    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
  });

  it('starts error capture by default after config fetch resolves', async () => {
    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();
    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
  });

  it('passes the shared identity getter into replay', async () => {
    const instance = init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    const replayOptions = vi.mocked(startReplay).mock.calls[0]?.[2] as
      | { getIdentity?: () => { email: string | null; userId: string | null } }
      | undefined;
    expect(replayOptions?.getIdentity).toEqual(expect.any(Function));

    instance.identify({ email: 'split@example.com', userId: 'user_split' });
    expect(replayOptions?.getIdentity?.()).toEqual({
      email: 'split@example.com',
      userId: 'user_split',
    });
  });

  it('fetches remote config', () => {
    init({ buildSlug: 'test-app', gate: false });
    expect(mockFetchRemoteConfig).toHaveBeenCalledWith('https://api.bworlds.co', 'test-app');
  });

  it('starts replay diagnostics and console/network telemetry by default with replay', async () => {
    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startReplayTelemetry).toHaveBeenCalledWith('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: true,
      networkTelemetry: true,
    });
    expect(startReplay).toHaveBeenCalledWith(
      'test-app',
      'https://api.bworlds.co',
      expect.objectContaining({ enableReplayDiagnostics: true }),
    );
  });

  it('passes local replay telemetry flags through activation', async () => {
    init({
      buildSlug: 'test-app',
      gate: false,
      enableReplayDiagnostics: false,
      enableConsoleTelemetry: false,
      enableNetworkTelemetry: false,
    });
    await flushMicrotasks();

    expect(startReplayTelemetry).toHaveBeenCalledWith('test-app', 'https://api.bworlds.co', {
      consoleTelemetry: false,
      networkTelemetry: false,
    });
    expect(startReplay).toHaveBeenCalledWith(
      'test-app',
      'https://api.bworlds.co',
      expect.objectContaining({ enableReplayDiagnostics: false }),
    );
  });

  it('does not start replay telemetry when stop() runs during replay start', async () => {
    let releaseStart!: () => void;
    vi.mocked(startReplay).mockImplementationOnce(async () => {
      setReplaySessionId('replay-session-test');
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
    });

    init({ buildSlug: 'test-app', gate: false });
    await vi.waitFor(() => expect(startReplay).toHaveBeenCalled());

    stop(); // stop while startReplay is mid-flight
    releaseStart(); // startReplay resolves after the stop
    await flushMicrotasks();

    expect(startReplayTelemetry).not.toHaveBeenCalled();
  });

  it('does not start replay telemetry when replay fails to record', async () => {
    // rrweb load/record failure: startReplay returns without publishing a session
    // id, so the console/network wrappers must not be installed.
    vi.mocked(startReplay).mockImplementationOnce(async () => {
      setReplaySessionId(null);
    });

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startReplay).toHaveBeenCalled();
    expect(startReplayTelemetry).not.toHaveBeenCalled();
  });

  it('stops heartbeat when remote config disables monitoring', async () => {
    mockFetchRemoteConfig.mockResolvedValue({ monitoring: false, sessionReplay: true, badge: false, gatingEnabled: false, allowedOrigin: null });

    init({ buildSlug: 'test-app', gate: false });
    await vi.waitFor(() => {
      expect(stopHeartbeat).toHaveBeenCalled();
    });
  });

  it('stops error capture and replay when remote config disables sessionReplay', async () => {
    mockFetchRemoteConfig.mockResolvedValue({ monitoring: true, sessionReplay: false, badge: false, gatingEnabled: false, allowedOrigin: null });

    init({ buildSlug: 'test-app', gate: false });
    await vi.waitFor(() => {
      expect(stopErrorCapture).toHaveBeenCalled();
    });
  });

  it('keeps everything running when remote config fetch fails', async () => {
    mockFetchRemoteConfig.mockResolvedValue(null);

    init({ buildSlug: 'test-app', gate: false });

    // Let promises settle
    await flushMicrotasks();

    expect(stopHeartbeat).not.toHaveBeenCalled();
    expect(stopErrorCapture).not.toHaveBeenCalled();
  });

  it('starts the badge widget when remote config enables badge', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: true,
      gatingEnabled: false,
      allowedOrigin: null,
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
      gatingEnabled: false,
      allowedOrigin: null,
    });

    init({ buildSlug: 'test-app', gate: false });

    await flushMicrotasks();

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
    // After stop(), re-init with different config resets module state.
    init({ buildSlug: 'my-app', gateOrigin: 'http://localhost:3939', gate: false });
    stop();
    vi.clearAllMocks();
    const instance = init({ buildSlug: 'my-app', gate: false });
    expect(instance.getGateUrl()).toBe('https://app.bworlds.co/access/my-app');
  });

  it('stop() calls stopHeartbeat and stopErrorCapture', () => {
    const instance = init({ buildSlug: 'test-app', gate: false });
    vi.clearAllMocks(); // Clear calls from init
    instance.stop();

    expect(stopHeartbeat).toHaveBeenCalled();
    expect(stopErrorCapture).toHaveBeenCalled();
  });
});

describe('top-level stop()', () => {
  it('calls stopHeartbeat and stopErrorCapture', () => {
    init({ buildSlug: 'test-app', gate: false });
    vi.clearAllMocks(); // Clear calls from init
    stop();

    expect(stopHeartbeat).toHaveBeenCalled();
    expect(stopErrorCapture).toHaveBeenCalled();
  });
});

describe('gate overlay', () => {
  it('shows overlay during access check', async () => {
    // Use a pending check so the overlay stays visible long enough to observe.
    let resolveCheck!: (v: CheckResult) => void;
    vi.mocked(check).mockReturnValueOnce(new Promise((r) => { resolveCheck = r; }));

    init({ buildSlug: 'test-app' });

    await vi.waitFor(() => {
      expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();
    });

    // Resolve check -> overlay removed
    resolveCheck({ valid: true, email: null, accessType: 'free', expiresAt: null, degraded: false });

    await vi.waitFor(() => {
      expect(document.getElementById('bworlds-gate-overlay')).toBeNull();
    });
  });

  it('removes overlay when check returns valid', async () => {
    // Use a pending check so we can observe the overlay before it's removed.
    let resolveCheck!: (v: CheckResult) => void;
    vi.mocked(check).mockReturnValueOnce(new Promise((r) => { resolveCheck = r; }));

    init({ buildSlug: 'test-app' });

    await vi.waitFor(() => {
      expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();
    });

    resolveCheck({ valid: true, email: null, accessType: 'paid', expiresAt: null, degraded: false });

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

    await vi.waitFor(() => {
      expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();
    });

    await vi.waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith('https://app.bworlds.co/access/test-app');
    });
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

    await vi.waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith('http://localhost:3939/access/test-app');
    });
  });

  it('does not show overlay when gate is disabled', async () => {
    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();
    expect(document.getElementById('bworlds-gate-overlay')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // gating_enabled_skip_overlay: cached gatingEnabled=false suppresses overlay
  // -------------------------------------------------------------------------

  it('gating_enabled_skip_overlay: when cached gatingEnabled=false, init does not mount overlay', async () => {
    // Cached gatingEnabled=false -> build is ungated -> overlay must NOT mount
    mockReadCachedGatingEnabled.mockReturnValue(false);

    init({ buildSlug: 'test-app' });
    await flushMicrotasks();

    // Overlay element must not exist in the DOM
    expect(document.getElementById('bworlds-gate-overlay')).toBeNull();
  });

  it('gating_enabled_skip_overlay: when cached gatingEnabled=false, check() is not called', async () => {
    // The validate-token call must be skipped entirely on the ungated path
    mockReadCachedGatingEnabled.mockReturnValue(false);

    init({ buildSlug: 'test-app' });
    await flushMicrotasks();

    // check() must not have been invoked (no validate-token call)
    expect(check).not.toHaveBeenCalled();
  });

  it('gating_enabled_true_mounts_overlay: when cached gatingEnabled=true, init mounts overlay and calls check()', async () => {
    // gatingEnabled=true (or cold cache default) -> overlay mounts and check() is called
    mockReadCachedGatingEnabled.mockReturnValue(true);
    // Use a pending check so overlay stays visible
    vi.mocked(check).mockReturnValueOnce(new Promise(() => {}));

    init({ buildSlug: 'test-app' });

    // Overlay is created inside activateSubsystems (after async config fetch)
    await vi.waitFor(() => {
      expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();
    });

    // check() must be called exactly once
    expect(check).toHaveBeenCalled();
  });

  it('cold_cache_mounts_overlay: cold cache (readCachedGatingEnabled=true) proceeds with overlay path', async () => {
    // Cold cache returns true (fail-safe default) -> overlay mounts
    mockReadCachedGatingEnabled.mockReturnValue(true);
    // Use a pending check so overlay stays visible
    vi.mocked(check).mockReturnValueOnce(new Promise(() => {}));

    init({ buildSlug: 'test-app' });

    await vi.waitFor(() => {
      expect(document.getElementById('bworlds-gate-overlay')).toBeTruthy();
    });
  });
});
