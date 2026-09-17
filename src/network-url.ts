import { MAX_URL_LENGTH, sanitizeAndTruncate } from './normalize-thrown';

export const REDACTED = '[REDACTED]';

// Match credential-bearing query parameters and headers across camelCase,
// snake_case, and kebab-case spellings.
const SENSITIVE_KEY_WORDS = new Set([
  'token',
  'access',
  'refresh',
  'auth',
  'authorization',
  'authentication',
  'password',
  'passwd',
  'secret',
  'key',
  'apikey',
  'jwt',
  'session',
  'cookie',
]);

export function isSdkTelemetryUrl(url: string, apiEndpoint: string): boolean {
  if (apiEndpoint === '') return false;
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const target = new URL(url, base);
    const endpoint = new URL(apiEndpoint, base);
    return target.origin === endpoint.origin && target.pathname.startsWith('/api/telemetry/');
  } catch {
    return false;
  }
}

export function isSensitiveNetworkKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/i);
  return words.some((word) => SENSITIVE_KEY_WORDS.has(word.toLowerCase()));
}

export function redactNetworkUrl(url: string): string {
  try {
    const parsed = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveNetworkKey(key)) parsed.searchParams.set(key, REDACTED);
    }
    return sanitizeAndTruncate(parsed.href, MAX_URL_LENGTH);
  } catch {
    return sanitizeAndTruncate(url, MAX_URL_LENGTH);
  }
}
