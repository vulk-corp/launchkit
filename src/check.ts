const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';
const COOKIE_NAME = 'bworlds_token';

export interface CheckResult {
  valid: boolean;
  email: string | null;
  accessType: 'free' | 'paid' | null;
  expiresAt: string | null;
  /** true when the backend was unreachable and fail-open was applied */
  degraded: boolean;
}

/**
 * Read the bworlds_token from the URL query string or a cookie.
 * The gate page sets it as ?bworlds_token=<jwt> on redirect.
 * On successful validation the SDK persists the token in a cookie
 * and strips it from the URL so the JWT doesn't linger in the address bar.
 */
function readToken(): { token: string | null; fromUrl: boolean } {
  if (typeof window === 'undefined') return { token: null, fromUrl: false };

  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get(COOKIE_NAME);
  if (urlToken) return { token: urlToken, fromUrl: true };

  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`),
  );
  return {
    token: match ? decodeURIComponent(match[1]) : null,
    fromUrl: false,
  };
}

/** Persist token as a cookie. Uses expires_at from the API when available. */
function persistToken(token: string, expiresAt: string | null): void {
  if (typeof document === 'undefined') return;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'path=/',
    'SameSite=Lax',
  ];
  if (expiresAt) {
    parts.push(`expires=${new Date(expiresAt).toUTCString()}`);
  }
  document.cookie = parts.join('; ');
}

/** Remove the bworlds_token param from the URL without a page reload. */
function stripTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(COOKIE_NAME)) return;
  url.searchParams.delete(COOKIE_NAME);
  window.history.replaceState(window.history.state, '', url.toString());
}

/** Delete the persisted cookie (e.g. after a 401). */
function clearToken(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}

/**
 * Validate the current client's access token against the BWORLDS API.
 * No arguments needed — the token is read from ?bworlds_token= or the cookie.
 *
 * On success the token is persisted in a cookie and stripped from the URL.
 * On 401/403 the cookie is cleared so stale tokens don't loop.
 *
 * Calls POST /api/monetization/validate-token server-side.
 * The build_secret never leaves the BWORLDS backend.
 */
export async function check(
  buildSlug: string,
  apiEndpoint = DEFAULT_API_ENDPOINT,
): Promise<CheckResult> {
  const { token, fromUrl } = readToken();

  try {
    const res = await fetch(`${apiEndpoint}/api/monetization/validate-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token ?? '', build_slug: buildSlug }),
    });

    if (res.status === 401 || res.status === 403) {
      clearToken();
      return { valid: false, email: null, accessType: null, expiresAt: null, degraded: false };
    }

    if (!res.ok) {
      // Server error (5xx) — fail-open so the builder's app stays accessible
      return { valid: true, email: null, accessType: null, expiresAt: null, degraded: true };
    }

    const data = (await res.json()) as { access_type: string; expires_at: string };

    if (token) {
      persistToken(token, data.expires_at);
      if (fromUrl) stripTokenFromUrl();
    }

    return {
      valid: true,
      email: null, // email not returned by validate-token (privacy)
      accessType: data.access_type as 'free' | 'paid',
      expiresAt: data.expires_at,
      degraded: false,
    };
  } catch {
    // Network error / timeout — fail-open
    return { valid: true, email: null, accessType: null, expiresAt: null, degraded: true };
  }
}
