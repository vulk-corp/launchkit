import { configureSender, sendTelemetry } from '../src/telemetry-sender';

const mockFetch = vi.fn(() => Promise.resolve(new Response()));

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Reset module-level _config by reconfiguring (no reset export exists)
});

describe('configureSender + sendTelemetry', () => {
  it('does nothing before configureSender is called', async () => {
    // Fresh import to get null _config
    vi.resetModules();
    const mod = await import('../src/telemetry-sender');
    await mod.sendTelemetry('/api/test', { foo: 'bar' });
    expect(mockFetch).not.toHaveBeenCalled();
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
