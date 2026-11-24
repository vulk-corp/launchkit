import { fetchJsonWithTimeout } from './fetch-util';

export interface SdkRemoteConfig {
  sessionReplay: boolean;
  monitoring: boolean;
  uptimeMonitoring?: boolean;
  errorCapture?: boolean;
  badge: boolean;
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
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.sessionReplay !== 'boolean' ||
      typeof parsed.monitoring !== 'boolean' ||
      typeof parsed.badge !== 'boolean' ||
      !(parsed.allowedOrigin === null || typeof parsed.allowedOrigin === 'string')
    ) {
      return null;
    }
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
  // Stale cache cannot enable replay.
  const cached = readCache(buildSlug);

  const fetchAndCache = fetchJsonWithTimeout<SdkRemoteConfig>(
    `${apiEndpoint}/api/telemetry/sdk-config?buildSlug=${encodeURIComponent(buildSlug)}`
  ).then((config) => {
    if (config) writeCache(buildSlug, config);
    return config;
  }).catch(() => null);

  // Without allowedOrigin, telemetry cannot be scoped to the registered Build URL.
  if (cached && 'allowedOrigin' in cached) {
    if (cached.sessionReplay === true) {
      const fresh = await fetchAndCache;
      return fresh ?? { ...cached, sessionReplay: false };
    }
    return cached;
  }
  return fetchAndCache;
}
