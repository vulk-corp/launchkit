import {
  clearIdentitySource,
  setIdentitySource,
  type IdentitySource,
} from './identity-state';

type SupabaseUserLike = {
  id?: unknown;
  email?: unknown;
};

type SupabaseSessionLike = {
  user?: SupabaseUserLike | null;
} | null;

type SupabaseSubscriptionLike = {
  unsubscribe?: () => void;
};

type SupabaseAuthStateChangeResult =
  | {
      data?: {
        subscription?: SupabaseSubscriptionLike;
      } | null;
    }
  | {
      subscription?: SupabaseSubscriptionLike;
    }
  | undefined;

export type SupabaseClientLike = {
  auth?: {
    getSession?: () => Promise<{
      data?: {
        session?: SupabaseSessionLike;
      } | null;
    }>;
    onAuthStateChange?: (
      callback: (event: string, session: SupabaseSessionLike) => void,
    ) => SupabaseAuthStateChangeResult;
  };
};

const AUTO_SOURCE: IdentitySource = 'supabase-auto';
const CONNECTED_SOURCE: IdentitySource = 'supabase';
const POLL_INTERVAL_MS = 2_000;
// String-length limits, checked before parsing app-owned values. Using code
// units avoids allocating an encoded copy of large image/data blobs.
const MIN_SESSION_LENGTH = 200;
const MAX_SESSION_LENGTH = 100 * 1024;
const MAX_ENCODED_COOKIE_LENGTH = MAX_SESSION_LENGTH * 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AutoIdentity = { email: string | null; userId: string };
type SessionCandidate = { identity: AutoIdentity; issuedAt: number };
type SessionLocation = {
  source: 'localStorage' | 'cookie';
  key: string;
  raw: string | null;
  identity: AutoIdentity | null;
};

let _autoTimer: ReturnType<typeof setInterval> | null = null;
let _storageHandler: ((event: StorageEvent) => void) | null = null;
let _connectedSubscription: SupabaseSubscriptionLike | null = null;
// Keep the location across logout. Configuration changes require a restart;
// the bridge does not keep searching for a newer session once it has a key.
let _autoSession: SessionLocation | null = null;

function _getLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Browser privacy modes can throw on localStorage access.
  }

  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function _identityFromSession(
  session: SupabaseSessionLike,
): AutoIdentity | null {
  const user = session?.user;
  const id = user?.id;
  if (typeof id !== 'string' || id.length === 0) return null;

  const email = user?.email;
  return {
    email: typeof email === 'string' && email.length > 0 ? email : null,
    userId: id,
  };
}

function _applySession(source: IdentitySource, session: SupabaseSessionLike): void {
  const identity = _identityFromSession(session);
  if (!identity) {
    clearIdentitySource(source);
    return;
  }
  setIdentitySource(source, identity.email, identity.userId);
}

function _looksLikeSupabaseAuthKey(key: string): boolean {
  return (
    (key.startsWith('sb-') && key.endsWith('-auth-token')) ||
    key === 'supabase.auth.token'
  );
}

function _parseStorageValue(raw: string): unknown {
  let parsed: unknown = JSON.parse(raw);
  if (typeof parsed === 'string') {
    parsed = JSON.parse(parsed);
  }
  return parsed;
}

function _sessionCandidates(parsed: unknown): SupabaseSessionLike[] {
  if (!parsed || typeof parsed !== 'object') return [];

  const record = parsed as Record<string, unknown>;
  return [
    parsed,
    record['session'],
    record['currentSession'],
    (record['data'] as Record<string, unknown> | undefined)?.['session'],
  ] as SupabaseSessionLike[];
}

/** Recognize GoTrue locally; this is not signature or authentication verification. */
function _customSessionIssuedAt(
  session: SupabaseSessionLike,
  discovering: boolean,
): number | null {
  const stored = session as {
    access_token?: unknown;
    user?: { id?: unknown; aud?: unknown; role?: unknown };
  };
  const user = stored.user;
  if (
    typeof stored.access_token !== 'string' ||
    typeof user?.id !== 'string' ||
    !UUID_RE.test(user.id) ||
    (user.aud !== 'authenticated' && user.role !== 'authenticated')
  ) return null;

  const parts = stored.access_token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  const parsed: unknown = JSON.parse(_decodeBase64Url(parts[1]));
  if (!parsed || typeof parsed !== 'object') return null;
  const claims = parsed as Record<string, unknown>;
  if (
    typeof claims.iss !== 'string' ||
    !claims.iss.endsWith('/auth/v1') ||
    claims.sub !== user.id ||
    claims.role !== 'authenticated' ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    typeof claims.iat !== 'number' ||
    !Number.isFinite(claims.iat) ||
    (discovering && claims.exp <= Date.now() / 1000)
  ) return null;

  return claims.iat;
}

function _candidateFromValue(
  key: string,
  raw: string | null,
  source: SessionLocation['source'],
  discovering: boolean,
): SessionCandidate | null {
  if (!raw) return null;
  const knownKey = _looksLikeSupabaseAuthKey(key);
  try {
    if (!knownKey && source === 'cookie' && raw.length > MAX_ENCODED_COOKIE_LENGTH) return null;
    const value = source === 'cookie' ? _decodeAuthCookieValue(raw) : raw;
    if (!knownKey && (
      value.length < MIN_SESSION_LENGTH ||
      value.length > MAX_SESSION_LENGTH ||
      // The unquoted marker also admits the existing double-encoded JSON format.
      !value.includes('access_token')
    )) return null;

    for (const session of _sessionCandidates(_parseStorageValue(value))) {
      const identity = _identityFromSession(session);
      if (!identity) continue;
      if (knownKey) return { identity, issuedAt: 0 };
      try {
        const issuedAt = _customSessionIssuedAt(session, discovering);
        if (issuedAt !== null) return { identity, issuedAt };
      } catch {
        // A malformed outer candidate must not hide a valid nested session.
      }
    }
  } catch {
    // Ignore malformed app-owned storage entries and cookies.
  }
  return null;
}

function _discoverSession(
  keys: string[],
  read: (key: string) => string | null,
  source: SessionLocation['source'],
): SessionLocation | null {
  let best: SessionLocation | null = null;
  let latestIssuedAt = -Infinity;
  // Known names retain their permissive legacy reader and priority. Only the
  // fallback scans arbitrary values and compares JWT issue times.
  for (const knownKey of [true, false]) {
    for (const key of keys) {
      if (_looksLikeSupabaseAuthKey(key) !== knownKey) continue;
      const raw = read(key);
      const candidate = _candidateFromValue(key, raw, source, true);
      if (!candidate) continue;
      if (knownKey) return { source, key, raw, identity: candidate.identity };
      if (candidate.issuedAt > latestIssuedAt) {
        best = { source, key, raw, identity: candidate.identity };
        latestIssuedAt = candidate.issuedAt;
      }
    }
  }
  return best;
}

function _updateSelectedSession(raw: string | null): void {
  if (!_autoSession || raw === _autoSession.raw) return;
  _autoSession.raw = raw;
  // Expiration helps discover the right key; Supabase owns token refresh and
  // logout after that. Cache only the identity, not the parsed session/claims.
  _autoSession.identity = _candidateFromValue(
    _autoSession.key, raw, _autoSession.source, false,
  )?.identity ?? null;
}

function _readStoredSupabaseSession(eventKey?: string): void {
  const storage = _getLocalStorage();
  if (!storage) {
    _updateSelectedSession(null);
    return;
  }

  try {
    if (_autoSession) {
      _updateSelectedSession(storage.getItem(_autoSession.key));
      return;
    }
    const keys: string[] = [];
    if (eventKey !== undefined) {
      keys.push(eventKey);
    } else {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key !== null) keys.push(key);
      }
    }
    _autoSession = _discoverSession(keys, (key) => storage.getItem(key), 'localStorage');
  } catch {
    _updateSelectedSession(null);
  }
}

const AUTH_COOKIE_PREFIX = 'base64-';

// Reused across decodes so the 2s poll does not allocate a decoder each tick.
let _textDecoder: TextDecoder | null = null;
let _lastCookieString: string | null = null;

function _readDocumentCookie(): string {
  try {
    return typeof document !== 'undefined' && typeof document.cookie === 'string'
      ? document.cookie
      : '';
  } catch {
    return '';
  }
}

/**
 * Decode a base64url string (the @supabase/ssr cookie encoding: URL-safe
 * alphabet, no padding, UTF-8 payload) back to its original string.
 */
function _decodeBase64Url(value: string): string {
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = base64.length % 4;
  if (remainder) base64 += '='.repeat(4 - remainder);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  _textDecoder ??= new TextDecoder();
  return _textDecoder.decode(bytes);
}

/** Turn one auth-cookie value into the session JSON string it carries. */
function _decodeAuthCookieValue(rawValue: string): string {
  let value = rawValue;
  try {
    value = decodeURIComponent(rawValue);
  } catch {
    // Not percent-encoded: use the value as read.
  }
  return value.startsWith(AUTH_COOKIE_PREFIX)
    ? _decodeBase64Url(value.slice(AUTH_COOKIE_PREFIX.length))
    : value;
}

/**
 * Cookie values by name, including custom names and reassembled `.0`/`.1` chunks.
 * Once selected, collect only that cookie and its chunks.
 */
function _collectAuthCookieValues(
  cookieString: string,
  selectedKey?: string,
): Map<string, string> {
  const singles = new Map<string, string>();
  const chunkGroups = new Map<string, Array<{ index: number; value: string }>>();

  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();

    const chunk = /^(.+)\.(\d+)$/.exec(name);
    if (selectedKey !== undefined && name !== selectedKey && chunk?.[1] !== selectedKey) continue;
    singles.set(name, value);
    if (chunk) {
      const group = chunkGroups.get(chunk[1]) ?? [];
      group.push({ index: Number(chunk[2]), value });
      chunkGroups.set(chunk[1], group);
    }
  }

  const values = new Map<string, string>();
  for (const [name, group] of chunkGroups) {
    if (singles.has(name)) continue;
    group.sort((a, b) => a.index - b.index);
    if (group.some((entry, index) => entry.index !== index)) continue;
    if (!_looksLikeSupabaseAuthKey(name) &&
      group.reduce((size, entry) => size + entry.value.length, 0) > MAX_ENCODED_COOKIE_LENGTH) continue;
    values.set(name, group.map((entry) => entry.value).join(''));
  }
  // Prefer reconstructed groups to their individual parts, while still allowing
  // a literal custom cookie name ending in `.N` when it holds a whole session.
  for (const [name, value] of singles) values.set(name, value);
  return values;
}

function _readCookieSupabaseSession(): void {
  const cookieString = _readDocumentCookie();
  // The cookie rarely changes between 2s ticks; skip the decode when it has not.
  if (cookieString === _lastCookieString) return;
  _lastCookieString = cookieString;

  const values = _collectAuthCookieValues(cookieString, _autoSession?.key);
  if (_autoSession) {
    _updateSelectedSession(values.get(_autoSession.key) ?? null);
  } else {
    _autoSession = _discoverSession([...values.keys()], (key) => values.get(key) ?? null, 'cookie');
  }
}

function _syncAutoIdentity(eventKey?: string): void {
  // Cookie first during discovery so stale localStorage cannot shadow SSR.
  // Once found, follow that location even through logout and subsequent login.
  if (_autoSession?.source !== 'localStorage') _readCookieSupabaseSession();
  if (!_autoSession || _autoSession.source === 'localStorage') _readStoredSupabaseSession(eventKey);
  const identity = _autoSession?.identity;
  if (identity) setIdentitySource(AUTO_SOURCE, identity.email, identity.userId);
  else clearIdentitySource(AUTO_SOURCE);
}

function _unsubscribeConnectedClient(): void {
  try {
    _connectedSubscription?.unsubscribe?.();
  } catch {
    // Third-party unsubscribe failures should not break SDK cleanup.
  }
  _connectedSubscription = null;
}

function _extractSubscription(
  result: SupabaseAuthStateChangeResult,
): SupabaseSubscriptionLike | null {
  if (!result) return null;
  const record = result as {
    data?: { subscription?: SupabaseSubscriptionLike } | null;
    subscription?: SupabaseSubscriptionLike;
  };
  return record.data?.subscription ?? record.subscription ?? null;
}

export function startSupabaseIdentityBridge(): void {
  // Cookie sessions (@supabase/ssr) live outside localStorage, so the bridge
  // runs whenever it has a DOM to read, not only when localStorage exists.
  if (typeof window === 'undefined') return;
  if (_autoTimer) return;

  _syncAutoIdentity();
  _storageHandler = (event: StorageEvent) => {
    if (_autoSession?.source === 'cookie') return;
    if (event.storageArea && event.storageArea !== _getLocalStorage()) return;
    if (event.key === null || !_autoSession || event.key === _autoSession.key) {
      // During discovery a storage event examines only the changed key. The
      // poll also finds logins in this tab, which emit no storage event here.
      _syncAutoIdentity(event.key ?? undefined);
    }
  };
  window.addEventListener('storage', _storageHandler);
  // Cookies emit no change event, so the poll is what catches cookie logins.
  _autoTimer = setInterval(_syncAutoIdentity, POLL_INTERVAL_MS);
}

export function connectSupabase(client: SupabaseClientLike): void {
  _unsubscribeConnectedClient();

  const auth = client?.auth;
  if (!auth) {
    clearIdentitySource(CONNECTED_SOURCE);
    return;
  }

  auth
    .getSession?.()
    .then((result) => {
      _applySession(CONNECTED_SOURCE, result.data?.session ?? null);
    })
    .catch(() => {
      clearIdentitySource(CONNECTED_SOURCE);
    });

  try {
    const result = auth.onAuthStateChange?.((_event, session) => {
      _applySession(CONNECTED_SOURCE, session);
    });
    _connectedSubscription = _extractSubscription(result);
  } catch {
    _connectedSubscription = null;
  }
}

export function stopSupabaseIdentityBridge(): void {
  if (_autoTimer) {
    clearInterval(_autoTimer);
    _autoTimer = null;
  }
  if (_storageHandler && typeof window !== 'undefined') {
    window.removeEventListener('storage', _storageHandler);
    _storageHandler = null;
  }
  _unsubscribeConnectedClient();
  _autoSession = null;
  _lastCookieString = null;
  clearIdentitySource(AUTO_SOURCE);
  clearIdentitySource(CONNECTED_SOURCE);
}
