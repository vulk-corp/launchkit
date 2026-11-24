import { fetchRemoteConfig, type SdkRemoteConfig } from '../src/remote-config';

const mockFetchJsonWithTimeout = vi.fn();

vi.mock('../src/fetch-util', () => ({
  fetchJsonWithTimeout: (...args: unknown[]) => mockFetchJsonWithTimeout(...args),
}));

function config(overrides: Partial<SdkRemoteConfig> = {}): SdkRemoteConfig {
  return {
    sessionReplay: false,
    monitoring: true,
    badge: false,
    allowedOrigin: 'https://my-app.example',
    ...overrides,
  };
}

let storage: Storage;

beforeEach(() => {
  vi.clearAllMocks();
  const values = new Map<string, string>();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  vi.stubGlobal('localStorage', storage);
  mockFetchJsonWithTimeout.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('remote telemetry configuration', () => {
  it('returns fresh configuration and makes it available from the cache', async () => {
    const fresh = config();
    mockFetchJsonWithTimeout.mockResolvedValueOnce(fresh);

    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual(fresh);
    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual(fresh);
  });

  it('uses cached configuration while refreshing it in the background', async () => {
    const cached = config();
    const fresh = config({ badge: true });
    localStorage.setItem('bworlds-sdk-config-my-app', JSON.stringify(cached));
    mockFetchJsonWithTimeout.mockResolvedValueOnce(fresh);

    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual(cached);
    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual(fresh);
  });

  it('requires fresh permission to enable replay from a cached configuration', async () => {
    const cached = config({ sessionReplay: true });
    const fresh = config({ sessionReplay: false });
    localStorage.setItem('bworlds-sdk-config-my-app', JSON.stringify(cached));
    mockFetchJsonWithTimeout.mockResolvedValueOnce(fresh);

    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual(fresh);
  });

  it('disables cached replay when fresh permission is unavailable', async () => {
    const cached = config({ sessionReplay: true });
    localStorage.setItem('bworlds-sdk-config-my-app', JSON.stringify(cached));
    mockFetchJsonWithTimeout.mockRejectedValueOnce(new Error('Network error'));

    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual({
      ...cached,
      sessionReplay: false,
    });
  });

  it.each(['{invalid-json', 'null', '42', '[]', '{"sessionReplay":false}'])(
    'falls back to fresh configuration for an unusable cache: %s',
    async (cached) => {
      const fresh = config();
      localStorage.setItem('bworlds-sdk-config-my-app', cached);
      mockFetchJsonWithTimeout.mockResolvedValueOnce(fresh);

      expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual(fresh);
    },
  );

  it('uses fresh configuration when browser storage cannot be read', async () => {
    const fresh = config();
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    mockFetchJsonWithTimeout.mockResolvedValueOnce(fresh);

    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual(fresh);
  });

  it('returns fresh configuration when browser storage cannot be written', async () => {
    const fresh = config();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    mockFetchJsonWithTimeout.mockResolvedValueOnce(fresh);

    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual(fresh);
  });

  it('keeps cached telemetry available after a background fetch fails', async () => {
    const cached = config();
    localStorage.setItem('bworlds-sdk-config-my-app', JSON.stringify(cached));
    mockFetchJsonWithTimeout.mockRejectedValueOnce(new Error('Network error'));

    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toEqual(cached);
  });

  it('returns null when neither storage nor the API supplies configuration', async () => {
    mockFetchJsonWithTimeout.mockRejectedValueOnce(new Error('Network error'));

    expect(await fetchRemoteConfig('https://api.test', 'my-app')).toBeNull();
    expect(localStorage.getItem('bworlds-sdk-config-my-app')).toBeNull();
  });

  it('keeps configuration scoped to each Build', async () => {
    const first = config({ allowedOrigin: 'https://first.example' });
    const second = config({ allowedOrigin: 'https://second.example' });
    localStorage.setItem('bworlds-sdk-config-first', JSON.stringify(first));
    localStorage.setItem('bworlds-sdk-config-second', JSON.stringify(second));

    expect(await fetchRemoteConfig('https://api.test', 'first')).toEqual(first);
    expect(await fetchRemoteConfig('https://api.test', 'second')).toEqual(second);
    expect(await fetchRemoteConfig('https://api.test', 'unknown')).toBeNull();
  });
});
