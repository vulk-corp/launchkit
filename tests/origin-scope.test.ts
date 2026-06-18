/**
 * Tests for #702 — SDK origin-scope guard.
 *
 * Covers verification map rows: F1, F2, F3, F4, F5, F6, T2, T6.
 */

import { init, stop } from '../src/index';
import { configureSender } from '../src/telemetry-sender';
import { startHeartbeat, stopHeartbeat } from '../src/heartbeat';
import { startErrorCapture, stopErrorCapture } from '../src/error-capture';
import { fetchRemoteConfig, readCachedGatingEnabled } from '../src/remote-config';
import { startBadgeWidget, stopBadgeWidget } from '../src/badge-widget';
import type { SdkRemoteConfig } from '../src/remote-config';

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

/** Helper: create a full SdkRemoteConfig with all features on + given allowedOrigin. */
function remoteConfig(allowedOrigin: string | null): SdkRemoteConfig {
  return {
    monitoring: true,
    sessionReplay: true,
    badge: true,
    gatingEnabled: false,
    allowedOrigin,
  };
}

/** Flush microtask queue so the deferred activation in init() completes. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Save and restore original location between tests. */
const originalLocation = window.location;

beforeEach(() => {
  stop();
  vi.clearAllMocks();
  document.getElementById('bworlds-gate-overlay')?.remove();
  mockFetchRemoteConfig.mockResolvedValue(null);
  mockReadCachedGatingEnabled.mockReturnValue(false);
  // Restore original location
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// F1 — Origin guard compares location.origin vs allowedOrigin
// ---------------------------------------------------------------------------

describe('F1 — origin guard comparison', () => {
  it('activates subsystems when location.origin matches allowedOrigin', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://my-app.com', href: 'https://my-app.com/page' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://my-app.com'));

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
  });

  it('does NOT activate subsystems when location.origin mismatches allowedOrigin', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://other-site.com', href: 'https://other-site.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://my-app.com'));

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startHeartbeat).not.toHaveBeenCalled();
    expect(startErrorCapture).not.toHaveBeenCalled();
  });

  it('activates subsystems when allowedOrigin is null (fail-open)', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://any-site.com', href: 'https://any-site.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig(null));

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
  });
});

// ---------------------------------------------------------------------------
// F2 — All subsystems off on mismatch
// ---------------------------------------------------------------------------

describe('F2 — all subsystems off on mismatch', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://wrong-site.com', href: 'https://wrong-site.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://legit-app.com'));
  });

  it('startHeartbeat is NOT called', async () => {
    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();
    expect(startHeartbeat).not.toHaveBeenCalled();
  });

  it('startErrorCapture is NOT called', async () => {
    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();
    expect(startErrorCapture).not.toHaveBeenCalled();
  });

  it('startBadgeWidget is NOT called even with badge: true', async () => {
    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();
    expect(startBadgeWidget).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F3 — Zero outbound requests after config fetch on mismatch
// ---------------------------------------------------------------------------

describe('F3 — zero outbound requests after config fetch on mismatch', () => {
  it('no fetch() calls happen after the initial config fetch', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://wrong.com', href: 'https://wrong.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://legit.com'));

    // Track all fetch calls via the global mock
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    // fetchRemoteConfig is mocked, so no real fetch() calls from it.
    // On mismatch, no subsystems start, so no additional fetch calls should occur.
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F4 — No console output on mismatch
// ---------------------------------------------------------------------------

describe('F4 — no console output on mismatch', () => {
  it('no console.warn or console.error on origin mismatch', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://wrong.com', href: 'https://wrong.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://legit.com'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F5 — dev: true bypasses origin check
// ---------------------------------------------------------------------------

describe('F5 — dev:true bypasses origin check', () => {
  it('all subsystems start on mismatched origin when dev: true', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost:3000', href: 'http://localhost:3000/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://production-app.com'));

    init({ buildSlug: 'test-app', gate: false, dev: true });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
  });

  it('badge widget starts on mismatched origin when dev: true', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost:5173', href: 'http://localhost:5173/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://production-app.com'));

    init({ buildSlug: 'test-app', gate: false, dev: true });
    await flushMicrotasks();

    expect(startBadgeWidget).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F6 — Badge not mounted on mismatch
// ---------------------------------------------------------------------------

describe('F6 — badge not mounted on mismatch', () => {
  it('startBadgeWidget is NOT called on mismatch even with badge: true in config', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://evil.com', href: 'https://evil.com/' },
      writable: true,
      configurable: true,
    });
    const config = remoteConfig('https://legit.com');
    config.badge = true;
    mockFetchRemoteConfig.mockResolvedValue(config);

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startBadgeWidget).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T2 — Strict origin equality
// ---------------------------------------------------------------------------

describe('T2 — strict origin equality', () => {
  it('https://example.com does NOT match https://example.com:443', async () => {
    // Browsers normalize :443 away for https, but if server returns it literally,
    // strict equality must catch the mismatch.
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://example.com', href: 'https://example.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://example.com:443'));

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    // Strict equality: "https://example.com" !== "https://example.com:443"
    expect(startHeartbeat).not.toHaveBeenCalled();
  });

  it('http://example.com does NOT match https://example.com', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://example.com', href: 'http://example.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://example.com'));

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startHeartbeat).not.toHaveBeenCalled();
  });

  it('https://example.com matches exactly https://example.com', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://example.com', href: 'https://example.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://example.com'));

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalled();
  });

  it('https://example.com MATCHES https://www.example.com (www normalization)', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://example.com', href: 'https://example.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://www.example.com'));

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalled();
  });

  it('https://www.example.com MATCHES https://example.com (www normalization reverse)', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://www.example.com', href: 'https://www.example.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://example.com'));

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T6 — Subsystems deferred until after origin check
// ---------------------------------------------------------------------------

describe('T6 — subsystems deferred until after origin check', () => {
  it('subsystems are NOT started synchronously during init()', () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://my-app.com', href: 'https://my-app.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://my-app.com'));

    // Call init but do NOT await flushMicrotasks
    init({ buildSlug: 'test-app', gate: false });

    // Subsystems should NOT have been called yet — they're deferred to after
    // the config fetch promise resolves.
    expect(startHeartbeat).not.toHaveBeenCalled();
    expect(startErrorCapture).not.toHaveBeenCalled();
    expect(startBadgeWidget).not.toHaveBeenCalled();
  });

  it('subsystems start only after config fetch resolves', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://my-app.com', href: 'https://my-app.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://my-app.com'));

    init({ buildSlug: 'test-app', gate: false });

    // Before flush: nothing started
    expect(startHeartbeat).not.toHaveBeenCalled();

    // After flush: subsystems activated
    await flushMicrotasks();
    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
  });
});

// ---------------------------------------------------------------------------
// Risk-driven additions — double-init guard, buildSlug validation
// ---------------------------------------------------------------------------

describe('risk-driven: double-init guard', () => {
  it('second init() call is ignored and warns', async () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://my-app.com', href: 'https://my-app.com/' },
      writable: true,
      configurable: true,
    });
    mockFetchRemoteConfig.mockResolvedValue(remoteConfig('https://my-app.com'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    init({ buildSlug: 'test-app', gate: false });
    init({ buildSlug: 'test-app', gate: false }); // second call

    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('init() called more than once')
    );

    warnSpy.mockRestore();
  });
});

describe('risk-driven: empty buildSlug', () => {
  it('init() with empty string buildSlug warns and does not start', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    init({ buildSlug: '', gate: false });
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('init() called without buildSlug')
    );
    expect(startHeartbeat).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('risk-driven: config fetch failure (fail-open)', () => {
  it('activates all subsystems when fetchRemoteConfig returns null', async () => {
    mockFetchRemoteConfig.mockResolvedValue(null);

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
  });

  it('activates all subsystems when fetchRemoteConfig rejects', async () => {
    mockFetchRemoteConfig.mockRejectedValue(new Error('Network timeout'));

    init({ buildSlug: 'test-app', gate: false });
    await flushMicrotasks();

    expect(startHeartbeat).toHaveBeenCalledWith('test-app');
    expect(startErrorCapture).toHaveBeenCalledWith('test-app');
  });
});
