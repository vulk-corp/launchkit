/**
 * Tests for remote-config.ts — localStorage SWR cache and gatingEnabled logic.
 *
 * Verification map slugs covered:
 * - localstorage_swr_contract: cache write succeeds; cache read returns parsed value;
 *   missing key returns null; corrupt JSON returns null; localStorage throws → returns null
 * - gating_enabled_skip_overlay: when cached gatingEnabled=false, readCachedGatingEnabled returns false
 * - cold_cache_mounts_overlay: cache miss → readCachedGatingEnabled returns true
 */

import { fetchRemoteConfig, readCachedGatingEnabled } from '../src/remote-config';

const mockFetchJsonWithTimeout = vi.fn();

vi.mock('../src/fetch-util', () => ({
  fetchJsonWithTimeout: (...args: unknown[]) => mockFetchJsonWithTimeout(...args),
}));

// ---------------------------------------------------------------------------
// Mock localStorage helpers
// ---------------------------------------------------------------------------

// Use a plain object with vi.fn() — cast to Storage to satisfy Object.defineProperty.
// Tests call .mockReturnValue() / .mockImplementation() on the mocked methods.
interface LocalStorageMock {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  length: number;
  key: ReturnType<typeof vi.fn>;
}

function mockLocalStorage(): LocalStorageMock {
  return {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn().mockReturnValue(null),
  };
}

let localStorageMock: LocalStorageMock;

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock = mockLocalStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
  mockFetchJsonWithTimeout.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Mock factory: SdkRemoteConfig shapes
// ---------------------------------------------------------------------------

function createMockSdkRemoteConfig(overrides: Partial<{
  sessionReplay: boolean;
  monitoring: boolean;
  badge: boolean;
  gatingEnabled: boolean;
  allowedOrigin: string | null;
}> = {}) {
  return {
    sessionReplay: false,
    monitoring: true,
    badge: false,
    gatingEnabled: false,
    allowedOrigin: null as string | null,
    ...overrides,
  };
}

function createMockGatedConfig() {
  return createMockSdkRemoteConfig({ gatingEnabled: true });
}

function createMockUngatedConfig() {
  return createMockSdkRemoteConfig({ gatingEnabled: false });
}

// ---------------------------------------------------------------------------
// localstorage_swr_contract
// ---------------------------------------------------------------------------

describe('localstorage_swr_contract', () => {
  it('cache write: fetched config is stored in localStorage', async () => {
    const config = createMockSdkRemoteConfig({ gatingEnabled: false });
    mockFetchJsonWithTimeout.mockResolvedValueOnce(config);

    await fetchRemoteConfig('https://api.test', 'my-app');

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'bworlds-sdk-config-my-app',
      JSON.stringify(config)
    );
  });

  it('cache read: subsequent call returns cached value without re-fetching', async () => {
    const config = createMockUngatedConfig();
    localStorageMock.getItem.mockReturnValue(JSON.stringify(config));

    const result = await fetchRemoteConfig('https://api.test', 'my-app');

    expect(result).toEqual(config);
  });

  it('missing cache key returns null (and fetch is called)', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    mockFetchJsonWithTimeout.mockResolvedValueOnce(null);

    const result = await fetchRemoteConfig('https://api.test', 'unknown-slug');

    expect(result).toBeNull();
    expect(mockFetchJsonWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('corrupt JSON in localStorage returns null (treated as cache miss)', async () => {
    localStorageMock.getItem.mockReturnValue('{not-valid-json}');
    mockFetchJsonWithTimeout.mockResolvedValueOnce(null);

    const result = await fetchRemoteConfig('https://api.test', 'my-app');

    // Corrupt cache → fetch was called (cache miss path)
    expect(mockFetchJsonWithTimeout).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('localStorage.getItem throws → treated as cache miss', async () => {
    localStorageMock.getItem.mockImplementation(() => {
      throw new Error('SecurityError: storage access denied');
    });
    mockFetchJsonWithTimeout.mockResolvedValueOnce(null);

    const result = await fetchRemoteConfig('https://api.test', 'my-app');

    // Should not throw; fetch is called as fallback
    expect(mockFetchJsonWithTimeout).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('localStorage.setItem throws → cache write fails silently', async () => {
    const config = createMockUngatedConfig();
    mockFetchJsonWithTimeout.mockResolvedValueOnce(config);
    localStorageMock.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    // Should not throw
    await expect(fetchRemoteConfig('https://api.test', 'my-app')).resolves.not.toThrow();
  });

  it('cached config with missing gatingEnabled field returns null', async () => {
    // Cache has a valid JSON object but no gatingEnabled field (old SDK cache format)
    const oldFormatConfig = { sessionReplay: false, monitoring: true, badge: false };
    localStorageMock.getItem.mockReturnValue(JSON.stringify(oldFormatConfig));
    mockFetchJsonWithTimeout.mockResolvedValueOnce(null);

    // readCachedGatingEnabled should return true (fail-safe: overlay mounts)
    const gating = readCachedGatingEnabled('my-app');
    expect(gating).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gating_enabled_skip_overlay
// ---------------------------------------------------------------------------

describe('gating_enabled_skip_overlay', () => {
  it('cached gatingEnabled=false → readCachedGatingEnabled returns false (skip overlay)', () => {
    const config = createMockUngatedConfig();
    localStorageMock.getItem.mockReturnValue(JSON.stringify(config));

    const result = readCachedGatingEnabled('my-app');

    expect(result).toBe(false);
  });

  it('cached gatingEnabled=true → readCachedGatingEnabled returns true (mount overlay)', () => {
    const config = createMockGatedConfig();
    localStorageMock.getItem.mockReturnValue(JSON.stringify(config));

    const result = readCachedGatingEnabled('my-app');

    expect(result).toBe(true);
  });

  it('readCachedGatingEnabled uses correct cache key per buildSlug', () => {
    localStorageMock.getItem.mockImplementation((key: unknown) => {
      if (key === 'bworlds-sdk-config-free-app') {
        return JSON.stringify(createMockUngatedConfig());
      }
      if (key === 'bworlds-sdk-config-paid-app') {
        return JSON.stringify(createMockGatedConfig());
      }
      return null;
    });

    expect(readCachedGatingEnabled('free-app')).toBe(false);
    expect(readCachedGatingEnabled('paid-app')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cold_cache_mounts_overlay
// ---------------------------------------------------------------------------

describe('cold_cache_mounts_overlay', () => {
  it('cold cache (no entry) → readCachedGatingEnabled returns true (overlay mounts)', () => {
    localStorageMock.getItem.mockReturnValue(null);

    const result = readCachedGatingEnabled('new-app');

    expect(result).toBe(true);
  });

  it('parse error in cache → readCachedGatingEnabled returns true (fail-safe)', () => {
    localStorageMock.getItem.mockReturnValue('invalid-json!');

    const result = readCachedGatingEnabled('my-app');

    expect(result).toBe(true);
  });

  it('localStorage throws → readCachedGatingEnabled returns true (fail-safe)', () => {
    localStorageMock.getItem.mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const result = readCachedGatingEnabled('my-app');

    expect(result).toBe(true);
  });

  it('cold cache triggers a fetch on fetchRemoteConfig', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    const config = createMockUngatedConfig();
    mockFetchJsonWithTimeout.mockResolvedValueOnce(config);

    await fetchRemoteConfig('https://api.test', 'my-app');

    expect(mockFetchJsonWithTimeout).toHaveBeenCalledWith(
      'https://api.test/api/telemetry/sdk-config?buildSlug=my-app'
    );
  });
});

// ---------------------------------------------------------------------------
// background_fetch_cache_integrity: fetch failure/null must not overwrite cache
// ---------------------------------------------------------------------------

describe('background_fetch_cache_integrity', () => {
  it('background fetch failure → fetchRemoteConfig still returns cached value', async () => {
    // Prime cache with ungated config
    const cachedConfig = createMockUngatedConfig();
    localStorageMock.getItem.mockReturnValue(JSON.stringify(cachedConfig));

    // Background fetch fails with network error (the background fetch fires but
    // its rejection is swallowed by .catch(() => null) in fetchRemoteConfig)
    mockFetchJsonWithTimeout.mockRejectedValueOnce(new Error('Network error'));

    const result = await fetchRemoteConfig('https://api.test', 'my-app');

    // Cached value must be returned regardless of background fetch outcome
    expect(result).toEqual(cachedConfig);
  });

  it('background fetch returns null → setItem not called with null (cache integrity)', async () => {
    // Cold cache (no entry) — fetch is the primary source
    localStorageMock.getItem.mockReturnValue(null);

    // fetch-util returns null (e.g., malformed JSON, network error converted to null)
    mockFetchJsonWithTimeout.mockResolvedValueOnce(null);

    const result = await fetchRemoteConfig('https://api.test', 'my-app');

    // No result from fetch and no cache
    expect(result).toBeNull();
    // setItem must NOT be called: null must never be written to cache
    // (if it were, the cache would contain the string "null" which would fail gatingEnabled check
    // and mount the overlay — correct — but is still an unintended write)
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('slug with special chars is URL-encoded in fetch URL', async () => {
    localStorageMock.getItem.mockReturnValue(null);
    mockFetchJsonWithTimeout.mockResolvedValueOnce(null);

    await fetchRemoteConfig('https://api.test', 'my app/slug');

    expect(mockFetchJsonWithTimeout).toHaveBeenCalledWith(
      'https://api.test/api/telemetry/sdk-config?buildSlug=my%20app%2Fslug'
    );
  });

  it('different buildSlugs use different cache keys (no collision)', () => {
    // slug-a → gatingEnabled=false; slug-b → gatingEnabled=true
    localStorageMock.getItem.mockImplementation((key: unknown) => {
      if (key === 'bworlds-sdk-config-slug-a') {
        return JSON.stringify(createMockUngatedConfig());
      }
      if (key === 'bworlds-sdk-config-slug-b') {
        return JSON.stringify(createMockGatedConfig());
      }
      return null;
    });

    // Slugs with matching suffixes must resolve independently
    expect(readCachedGatingEnabled('slug-a')).toBe(false);
    expect(readCachedGatingEnabled('slug-b')).toBe(true);
    // 'a' is not affected by 'slug-a' cache
    expect(readCachedGatingEnabled('a')).toBe(true); // cold cache → overlay mounts
  });
});

// ---------------------------------------------------------------------------
// polarity_invariant: readCachedGatingEnabled must return true on every error path
//
// This block is the regression anchor for the fail-safe polarity rule:
// gatingEnabled defaults to TRUE on every unhappy path so paid content is
// never accidentally exposed by a cache miss, parse failure, or storage error.
// ---------------------------------------------------------------------------

describe('polarity_invariant', () => {
  it('polarity_invariant: cache miss returns true (cold cache → overlay mounts)', () => {
    localStorageMock.getItem.mockReturnValue(null);
    expect(readCachedGatingEnabled('my-app')).toBe(true);
  });

  it('polarity_invariant: cache parse error returns true (corrupt JSON → overlay mounts)', () => {
    localStorageMock.getItem.mockReturnValue('{corrupt-json!');
    expect(readCachedGatingEnabled('my-app')).toBe(true);
  });

  it('polarity_invariant: missing gatingEnabled field returns true (old cache format → overlay mounts)', () => {
    // Cache has a valid JSON object but no gatingEnabled field (e.g. SDK 1.3.0 cache)
    localStorageMock.getItem.mockReturnValue(
      JSON.stringify({ sessionReplay: false, monitoring: true, badge: false })
    );
    expect(readCachedGatingEnabled('my-app')).toBe(true);
  });

  it('polarity_invariant: localStorage.getItem throws SecurityError returns true (→ overlay mounts)', () => {
    localStorageMock.getItem.mockImplementation(() => {
      throw new Error('SecurityError: The operation is insecure.');
    });
    expect(readCachedGatingEnabled('my-app')).toBe(true);
  });

  it('polarity_invariant: gatingEnabled=null in cache returns true (non-boolean → overlay mounts)', () => {
    // gatingEnabled is present but not a boolean — readCache treats it as a cache miss
    localStorageMock.getItem.mockReturnValue(
      JSON.stringify({ sessionReplay: false, monitoring: true, badge: false, gatingEnabled: null })
    );
    expect(readCachedGatingEnabled('my-app')).toBe(true);
  });

  it('polarity_invariant: only explicit gatingEnabled=false skips overlay', () => {
    localStorageMock.getItem.mockReturnValue(
      JSON.stringify({ sessionReplay: false, monitoring: true, badge: false, gatingEnabled: false })
    );
    // This is the ONLY case where the overlay should be skipped
    expect(readCachedGatingEnabled('my-app')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// index.ts integration: gating skip behavior (behavior test stubs)
// ---------------------------------------------------------------------------

describe('gating overlay skip integration', () => {
  it.todo('gating_enabled_skip_overlay: when cached gatingEnabled=false, init does not mount overlay or call check()');
  it.todo('cold_cache_mounts_overlay: cache miss → init proceeds with overlay path');
  it.todo('gating_enabled_true_mounts_overlay: when cached gatingEnabled=true, init mounts overlay and calls check()');
});
