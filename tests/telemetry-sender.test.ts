import { configureSender, sendTelemetry } from '../src/telemetry-sender';

const mockFetch = vi.fn(() => Promise.resolve(new Response()));

const SENDER_STATE_KEY = '__bworldsLaunchKitSenderState__';

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockClear();
  // The config lives on globalThis (CDN bundle-split resilience); clear it so
  // each test starts unconfigured.
  Reflect.deleteProperty(globalThis, SENDER_STATE_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, SENDER_STATE_KEY);
});

describe('configureSender + sendTelemetry', () => {
  it('does nothing before configureSender is called', async () => {
    vi.resetModules();
    const mod = await import('../src/telemetry-sender');
    await mod.sendTelemetry('/api/test', { foo: 'bar' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shares the config across duplicated module instances', async () => {
    // CDN ESM providers (esm.sh) rebundle the package per entrypoint, giving
    // the dynamically imported replay chunk its own copy of this module.
    // configureSender runs in the entry copy; sends from the duplicate must
    // still see the config or every replay diagnostic is silently dropped.
    vi.resetModules();
    const entryCopy = await import('../src/telemetry-sender');
    vi.resetModules();
    const replayCopy = await import('../src/telemetry-sender');
    expect(replayCopy).not.toBe(entryCopy);

    entryCopy.configureSender({ buildSlug: 'test-app', apiEndpoint: 'https://custom.api' });
    await replayCopy.sendTelemetry('/api/telemetry/replay-diagnostics', { probe: true });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://custom.api/api/telemetry/replay-diagnostics',
      expect.anything(),
    );
  });

  it('POSTs to the correct URL with JSON body and keepalive', async () => {
    configureSender({ buildSlug: 'test-app', apiEndpoint: 'https://custom.api' });
    await sendTelemetry('/api/telemetry/heartbeat', { buildSlug: 'test-app' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://custom.api/api/telemetry/heartbeat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildSlug: 'test-app' }),
        keepalive: true,
      }),
    );
  });

  it('uses default endpoint when apiEndpoint is omitted', async () => {
    configureSender({ buildSlug: 'test-app' });
    await sendTelemetry('/api/telemetry/heartbeat', { buildSlug: 'test-app' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.bworlds.co/api/telemetry/heartbeat',
      expect.anything(),
    );
  });

  it('silently catches fetch errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));
    configureSender({ buildSlug: 'test-app' });

    // Should not throw
    await expect(sendTelemetry('/api/test', {})).resolves.toBeUndefined();
  });
});
