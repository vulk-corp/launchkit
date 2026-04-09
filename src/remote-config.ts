/**
 * Remote SDK config fetcher + sessionStorage cache.
 *
 * Non-blocking: callers start the fetch and merge when it resolves.
 * Falls back silently on any error — local defaults always win on failure.
 */

export interface SdkRemoteConfig {
  sessionReplay: boolean;
  monitoring: boolean;
}

// Cache is session-scoped (sessionStorage): never expires within tab, clears on tab close.

function cacheKey(buildSlug: string): string {
  return `bworlds-sdk-config-${buildSlug}`;
}

function readCache(buildSlug: string): SdkRemoteConfig | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(buildSlug));
    if (!raw) return null;
    return JSON.parse(raw) as SdkRemoteConfig;
  } catch {
    return null;
  }
}

function writeCache(buildSlug: string, config: SdkRemoteConfig): void {
  try {
    sessionStorage.setItem(cacheKey(buildSlug), JSON.stringify(config));
  } catch {
    // sessionStorage unavailable — skip cache write, not fatal
  }
}

/**
 * Fetch remote config for a build. Returns null on any error.
 * Uses sessionStorage cache: skips network if already fetched this session.
 */
export async function fetchRemoteConfig(
  apiEndpoint: string,
  buildSlug: string
): Promise<SdkRemoteConfig | null> {
  const cached = readCache(buildSlug);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(
      `${apiEndpoint}/api/telemetry/sdk-config?buildSlug=${encodeURIComponent(buildSlug)}`,
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    const config = (await res.json()) as SdkRemoteConfig;
    writeCache(buildSlug, config);
    return config;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
