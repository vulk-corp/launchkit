import { check, getGateUrl, init, stop, type CheckResult } from '../src/index';
import { configureSender } from '../src/telemetry-sender';
import { startHeartbeat, stopHeartbeat } from '../src/heartbeat';
import { startErrorCapture, stopErrorCapture } from '../src/error-capture';
import { fetchRemoteConfig } from '../src/remote-config';
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
}));

vi.mock('../src/badge-widget', () => ({
  startBadgeWidget: vi.fn(),
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

beforeEach(() => {
  // Reset SDK state so _initialized is false for each test.
  stop();
  vi.clearAllMocks();
  setReplaySessionId(null);
  mockFetchRemoteConfig.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Flush microtask queue so the deferred activation in init() completes. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('init()', () => {
  it('grants free access through the v1 helpers without reading or sending a token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const instance = init({
        buildSlug: 'test-app',
        gate: true,
        gateOrigin: 'https://preview.example',
      });
      const result: CheckResult = await instance.check();
      expect(result).toEqual({
        valid: true,
        email: null,
        accessType: 'free',
        expiresAt: null,
        degraded: false,
      });
      expect(await check()).toEqual(result);
      expect(instance.getGateUrl()).toBe('https://preview.example/access/test-app');
      expect(getGateUrl()).toBe(instance.getGateUrl());
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps access helpers on duplicate and invalid initialization results', async () => {
    const first = init({ buildSlug: 'test-app' });
    const duplicate = init({ buildSlug: 'test-app' });
    stop();
    const invalid = init({ buildSlug: '' });
    for (const instance of [first, duplicate, invalid]) {
      expect(instance.check).toEqual(expect.any(Function));
      expect(instance.getGateUrl).toEqual(expect.any(Function));
    }
  });

  it('links the trust badge to the configured origin', async () => {
    const badge = await vi.importActual<typeof import('../src/badge-widget')>('../src/badge-widget');
    vi.mocked(startBadgeWidget).mockImplementationOnce(badge.startBadgeWidget);
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: false,
      badge: true,
      allowedOrigin: null,
    });
    try {
      init({
        buildSlug: 'test-app',
        gate: false,
        gateOrigin: 'https://preview.example',
      });
      await flushMicrotasks();
      const anchor = document
        .getElementById('bworlds-trust-badge')
        ?.shadowRoot?.querySelector('a');
      expect(anchor?.href).toBe('https://preview.example/builds/test-app/trust');
    } finally {
      badge.stopBadgeWidget();
    }
  });

  it('calls configureSender with buildSlug and apiEndpoint', () => {
    init({ buildSlug: 'test-app', apiEndpoint: 'https://custom.api' });

    expect(configureSender).toHaveBeenCalledWith({
      buildSlug: 'test-app',
      apiEndpoint: 'https://custom.api',
    });
  });

  it('normalizes a trailing slash from apiEndpoint before configuring subsystems', () => {
    init({ buildSlug: 'test-app', apiEndpoint: 'https://custom.api/proxy/' });

    expect(configureSender).toHaveBeenCalledWith({
      buildSlug: 'test-app',
      apiEndpoint: 'https://custom.api/proxy',
    });
    expect(mockFetchRemoteConfig).toHaveBeenCalledWith(
      'https://custom.api/proxy',
      'test-app',
    );
  });

  it('starts heartbeat by default after config fetch resolves', async () => {
    init({ buildSlug: 'test-app' });
    await flushMicrotasks();
    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
  });

  it('starts error capture by default after config fetch resolves', async () => {
    init({ buildSlug: 'test-app' });
    await flushMicrotasks();
    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
  });

  it('passes the shared identity getter into replay', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: false,
      allowedOrigin: null,
    });

    const instance = init({ buildSlug: 'test-app' });
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
    init({ buildSlug: 'test-app' });
    expect(mockFetchRemoteConfig).toHaveBeenCalledWith('https://api.bworlds.co', 'test-app');
  });

  it('starts replay diagnostics and console/network telemetry by default with replay', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: false,
      allowedOrigin: null,
    });

    init({ buildSlug: 'test-app' });
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
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: false,
      allowedOrigin: null,
    });

    init({
      buildSlug: 'test-app',
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
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: false,
      allowedOrigin: null,
    });

    let releaseStart!: () => void;
    vi.mocked(startReplay).mockImplementationOnce(async () => {
      setReplaySessionId('replay-session-test');
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
    });

    init({ buildSlug: 'test-app' });
    await vi.waitFor(() => expect(startReplay).toHaveBeenCalled());

    stop(); // stop while startReplay is mid-flight
    releaseStart(); // startReplay resolves after the stop
    await flushMicrotasks();

    expect(startReplayTelemetry).not.toHaveBeenCalled();
  });

  it('does not start replay telemetry when replay fails to record', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: false,
      allowedOrigin: null,
    });

    // rrweb load/record failure: startReplay returns without publishing a session
    // id, so the console/network wrappers must not be installed.
    vi.mocked(startReplay).mockImplementationOnce(async () => {
      setReplaySessionId(null);
    });

    init({ buildSlug: 'test-app' });
    await flushMicrotasks();

    expect(startReplay).toHaveBeenCalled();
    expect(startReplayTelemetry).not.toHaveBeenCalled();
  });

  it('starts heartbeat even when remote config disables monitoring', async () => {
    mockFetchRemoteConfig.mockResolvedValue({ monitoring: false, sessionReplay: true, badge: false, allowedOrigin: null });

    init({ buildSlug: 'test-app' });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
    expect(stopHeartbeat).not.toHaveBeenCalled();
  });

  it('ignores remote uptime fields when starting heartbeat', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: false,
      uptimeMonitoring: false,
      sessionReplay: true,
      badge: false,
      allowedOrigin: null,
    });

    init({ buildSlug: 'test-app' });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
  });

  it('does not start error capture or replay when sessionReplay disables the legacy combined feature', async () => {
    mockFetchRemoteConfig.mockResolvedValue({ monitoring: true, sessionReplay: false, badge: false, allowedOrigin: null });

    init({ buildSlug: 'test-app' });
    await flushMicrotasks();

    expect(startErrorCapture).not.toHaveBeenCalled();
    expect(startReplay).not.toHaveBeenCalled();
    expect(stopErrorCapture).not.toHaveBeenCalled();
  });

  it('starts error capture without replay when errorCapture is enabled and sessionReplay is disabled', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      errorCapture: true,
      sessionReplay: false,
      badge: false,
      allowedOrigin: null,
    });

    init({ buildSlug: 'test-app' });
    await flushMicrotasks();

    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
    expect(startReplay).not.toHaveBeenCalled();
  });

  it('keeps heartbeat running when builder-controlled telemetry toggles are disabled', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: false,
      uptimeMonitoring: false,
      errorCapture: false,
      sessionReplay: false,
      badge: false,
      allowedOrigin: null,
    });

    init({ buildSlug: 'test-app' });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
    expect(startErrorCapture).not.toHaveBeenCalled();
    expect(startReplay).not.toHaveBeenCalled();
  });

  it('keeps lower-sensitivity telemetry running when remote config fetch fails', async () => {
    mockFetchRemoteConfig.mockResolvedValue(null);

    init({ buildSlug: 'test-app' });

    // Let promises settle
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
    expect(startReplay).not.toHaveBeenCalled();
  });

  it('starts the badge widget when remote config enables badge', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: true,
      allowedOrigin: null,
    });

    init({ buildSlug: 'test-app' });

    await vi.waitFor(() => {
      expect(startBadgeWidget).toHaveBeenCalledWith('test-app', 'https://app.bworlds.co');
    });
  });

  it('does not start the badge widget when remote config disables badge', async () => {
    mockFetchRemoteConfig.mockResolvedValue({
      monitoring: true,
      sessionReplay: true,
      badge: false,
      allowedOrigin: null,
    });

    init({ buildSlug: 'test-app' });

    await flushMicrotasks();

    expect(startBadgeWidget).not.toHaveBeenCalled();
  });


});

describe('LaunchKitInstance', () => {
  it('stop() calls stopHeartbeat and stopErrorCapture', () => {
    const instance = init({ buildSlug: 'test-app' });
    vi.clearAllMocks(); // Clear calls from init
    instance.stop();

    expect(stopHeartbeat).toHaveBeenCalled();
    expect(stopErrorCapture).toHaveBeenCalled();
  });
});

describe('top-level stop()', () => {
  it('calls stopHeartbeat and stopErrorCapture', () => {
    init({ buildSlug: 'test-app' });
    vi.clearAllMocks(); // Clear calls from init
    stop();

    expect(stopHeartbeat).toHaveBeenCalled();
    expect(stopErrorCapture).toHaveBeenCalled();
  });
});
