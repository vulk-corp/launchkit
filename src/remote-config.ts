/**
 * Remote SDK config fetcher + sessionStorage cache.
 *
 * Non-blocking: callers start the fetch and merge when it resolves.
 * Falls back silently on any error — local defaults always win on failure.
 */

import { fetchJsonWithTimeout } from './fetch-util';

export interface SdkRemoteConfig {
  sessionReplay: boolean;
  monitoring: boolean;
  badge: boolean;
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

export async function fetchRemoteConfig(
  apiEndpoint: string,
  buildSlug: string
): Promise<SdkRemoteConfig | null> {
  const cached = readCache(buildSlug);
  if (cached) return cached;

  const config = await fetchJsonWithTimeout<SdkRemoteConfig>(
    `${apiEndpoint}/api/telemetry/sdk-config?buildSlug=${encodeURIComponent(buildSlug)}`
  );
  if (config) writeCache(buildSlug, config);
  return config;
}
