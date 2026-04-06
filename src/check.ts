const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';

export interface CheckResult {
  valid: boolean;
  email: string | null;
  accessType: 'free' | 'paid' | null;
  expiresAt: string | null;
}

/**
 * Read the bworlds_token from the URL query string or a cookie.
 * The gate page sets it as ?bworlds_token=<jwt> on redirect.
 * After the first check, callers should persist it in a cookie.
 */
function readToken(): string | null {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('bworlds_token');
  if (urlToken) return urlToken;

  const match = document.cookie.match(/(?:^|;\s*)bworlds_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Validate the current client's access token against the BWORLDS API.
 * No arguments needed — the token is read from ?bworlds_token= or the cookie.
 *
 * Calls POST /api/monetization/validate-token server-side.
 * The build_secret never leaves the BWORLDS backend.
 */
export async function check(
  buildSlug: string,
  apiEndpoint = DEFAULT_API_ENDPOINT,
): Promise<CheckResult> {
  const token = readToken() ?? '';

  try {
    const res = await fetch(`${apiEndpoint}/api/monetization/validate-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, build_slug: buildSlug }),
    });

    if (!res.ok) {
      return { valid: false, email: null, accessType: null, expiresAt: null };
    }

    const data = (await res.json()) as { access_type: string; expires_at: string };
    return {
      valid: true,
      email: null, // email not returned by validate-token (privacy)
      accessType: data.access_type as 'free' | 'paid',
      expiresAt: data.expires_at,
    };
  } catch {
    // Silent fail: never crash the host app on network error
    return { valid: false, email: null, accessType: null, expiresAt: null };
  }
}
