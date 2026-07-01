/**
 * Remote SDK config fetcher + localStorage SWR cache.
 *
 * Non-blocking: callers start the fetch and merge when it resolves.
 * Falls back silently on any error — local defaults always win on failure.
 *
 * Cache strategy (stale-while-revalidate):
 * - Synchronous read from localStorage on every init (cross-tab persistence).
 * - Background fetch fires unconditionally; response overwrites cache for next load.
 * - localStorage chosen over sessionStorage: cross-tab persistence is required so
 *   "no overlay on any refresh after the first-ever visit to a fresh tab" holds
 *   even when the user opens a new tab (sessionStorage is per-tab, so it would miss).
 *
 * gatingEnabled fail-safe polarity:
 * - Cold cache / parse error / no `gatingEnabled` field → return null → overlay mounts.
 * - Cached gatingEnabled === false → only then skip overlay (explicit opt-out).
 * - Any other value (true, undefined, missing) → overlay mounts (safe default).
 *
 * localStorage may throw SecurityError in Safari private mode. All access is wrapped
 * in try/catch; any failure is treated as a cache miss (overlay mounts).
 */

import { fetchJsonWithTimeout } from './fetch-util';

export interface SdkRemoteConfig {
  sessionReplay: boolean;
  monitoring: boolean;
  badge: boolean;
  /**
   * When false, the build has no paid pricing — the overlay can be skipped on cache hit.
   * Fail-safe: absent field is treated as true (overlay mounts).
   */
  gatingEnabled: boolean;
  /**
   * Origin derived from the build's registered URL (e.g. "https://myapp.com").
   * SDK compares this against `window.location.origin` to scope telemetry.
   * Null means "no restriction" (fail-open for backward compat).
   */
  allowedOrigin: string | null;
  /** Optional replay diagnostic kill switch. Absent means enabled. */
  enableReplayDiagnostics?: boolean;
  /** Optional console timeline telemetry kill switch. Absent means enabled with replay. */
  enableConsoleTelemetry?: boolean;
  /** Optional network timeline telemetry kill switch. Absent means enabled with replay. */
  enableNetworkTelemetry?: boolean;
}

// Cache is cross-tab persistent (localStorage): survives tab close/reopen.
// Key convention: bworlds-sdk-config-{slug} (hyphens, not colons).

function cacheKey(buildSlug: string): string {
  return `bworlds-sdk-config-${buildSlug}`;
}

function readCache(buildSlug: string): SdkRemoteConfig | null {
  try {
    const raw = localStorage.getItem(cacheKey(buildSlug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SdkRemoteConfig>;
    // Require gatingEnabled to be explicitly present and a boolean.
    // Missing field → treat as cache miss so overlay mounts (fail-safe).
    if (typeof parsed.gatingEnabled !== 'boolean') return null;
    return parsed as SdkRemoteConfig;
  } catch {
    // SecurityError (Safari private mode) or JSON parse failure → cache miss.
    return null;
  }
}

function writeCache(buildSlug: string, config: SdkRemoteConfig): void {
  try {
    localStorage.setItem(cacheKey(buildSlug), JSON.stringify(config));
  } catch {
    // localStorage unavailable (SecurityError, quota exceeded) — skip cache write, not fatal
  }
}

export async function fetchRemoteConfig(
  apiEndpoint: string,
  buildSlug: string
): Promise<SdkRemoteConfig | null> {
  // SWR: return cached value immediately, but always kick off a background fetch.
  // The background fetch result is NOT returned here — callers use the return value
  // for feature-flag decisions (monitoring, replay, badge) only. The gatingEnabled
  // skip-overlay decision happens in index.ts via readCachedGatingEnabled(), which
  // reads localStorage synchronously before this fetch's Promise resolves.
  const cached = readCache(buildSlug);

  const fetchAndCache = fetchJsonWithTimeout<SdkRemoteConfig>(
    `${apiEndpoint}/api/telemetry/sdk-config?buildSlug=${encodeURIComponent(buildSlug)}`
  ).then((config) => {
    if (config) writeCache(buildSlug, config);
    return config;
  }).catch(() => null);

  // Return cached value if available AND it contains the allowedOrigin field.
  // Old cached configs (pre-origin-scope) lack allowedOrigin — wait for the
  // network fetch so the origin guard in index.ts has data to work with.
  if (cached && 'allowedOrigin' in cached) return cached;
  return fetchAndCache;
}

/**
 * Read the cached gatingEnabled value synchronously.
 *
 * Returns false ONLY when the cache explicitly contains gatingEnabled=false.
 * Returns true (overlay should mount) on:
 *   - cache miss
 *   - parse error
 *   - missing gatingEnabled field
 *   - any localStorage error
 *
 * This is the fail-safe polarity: default to gating on, skip only on explicit false.
 */
export function readCachedGatingEnabled(buildSlug: string): boolean {
  const cached = readCache(buildSlug);
  if (cached === null) return true; // cache miss → overlay mounts
  return cached.gatingEnabled !== false; // explicit false → skip overlay; anything else → mount
}
