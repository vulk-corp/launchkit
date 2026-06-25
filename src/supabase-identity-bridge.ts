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

let _autoTimer: ReturnType<typeof setInterval> | null = null;
let _storageHandler: ((event: StorageEvent) => void) | null = null;
let _connectedSubscription: SupabaseSubscriptionLike | null = null;

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
): { email: string | null; userId: string } | null {
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

function _sessionFromParsedValue(parsed: unknown): SupabaseSessionLike {
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const candidates = [
    parsed,
    record['session'],
    record['currentSession'],
    (record['data'] as Record<string, unknown> | undefined)?.['session'],
  ];

  for (const candidate of candidates) {
    if (_identityFromSession(candidate as SupabaseSessionLike)) {
      return candidate as SupabaseSessionLike;
    }
  }

  return null;
}

function _readStoredSupabaseSession(): SupabaseSessionLike {
  const storage = _getLocalStorage();
  if (!storage) return null;

  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !_looksLikeSupabaseAuthKey(key)) continue;

      const raw = storage.getItem(key);
      if (!raw) continue;

      try {
        const session = _sessionFromParsedValue(_parseStorageValue(raw));
        if (session) return session;
      } catch {
        // Ignore malformed app-owned storage entries.
      }
    }
  } catch {
    return null;
  }

  return null;
}

const AUTH_COOKIE_PREFIX = 'base64-';

// Reused across decodes so the 2s poll does not allocate a decoder each tick.
let _textDecoder: TextDecoder | null = null;
let _lastCookieString: string | null = null;
let _lastCookieSession: SupabaseSessionLike = null;

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
 * Each sb-*-auth-token value from document.cookie, reassembling chunked cookies
 * (`sb-*-auth-token.0`, `.1`, …) in index order. @supabase/ssr splits large
 * sessions across numbered cookies; the parts concatenate back to one value.
 */
function _collectAuthCookieValues(cookieString: string): string[] {
  if (!cookieString) return [];

  const singles: string[] = [];
  const chunkGroups = new Map<string, Array<{ index: number; value: string }>>();

  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();

    // A trailing `.N` marks a chunk; the base name owns the auth-key shape, so
    // _looksLikeSupabaseAuthKey stays the single source of truth for it.
    const chunk = /^(.+)\.(\d+)$/.exec(name);
    if (chunk && _looksLikeSupabaseAuthKey(chunk[1])) {
      const group = chunkGroups.get(chunk[1]) ?? [];
      group.push({ index: Number(chunk[2]), value });
      chunkGroups.set(chunk[1], group);
    } else if (_looksLikeSupabaseAuthKey(name)) {
      singles.push(value);
    }
  }

  const values = [...singles];
  for (const group of chunkGroups.values()) {
    group.sort((a, b) => a.index - b.index);
    values.push(group.map((entry) => entry.value).join(''));
  }
  return values;
}

function _readCookieSupabaseSession(): SupabaseSessionLike {
  const cookieString = _readDocumentCookie();
  // The cookie rarely changes between 2s ticks; skip the decode when it has not.
  if (cookieString === _lastCookieString) return _lastCookieSession;
  _lastCookieString = cookieString;

  let result: SupabaseSessionLike = null;
  for (const rawValue of _collectAuthCookieValues(cookieString)) {
    try {
      const session = _sessionFromParsedValue(
        _parseStorageValue(_decodeAuthCookieValue(rawValue)),
      );
      if (session) {
        result = session;
        break;
      }
    } catch {
      // Ignore malformed or non-Supabase cookies.
    }
  }
  _lastCookieSession = result;
  return result;
}

function _syncAutoIdentity(): void {
  // Cookie first: an @supabase/ssr app's live session is in the cookie, and a
  // stale localStorage token must not shadow it. localStorage apps have no auth
  // cookie, so they fall through to the stored session unchanged.
  const session = _readCookieSupabaseSession() ?? _readStoredSupabaseSession();
  _applySession(AUTO_SOURCE, session);
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
    if (!event.key || _looksLikeSupabaseAuthKey(event.key)) {
      _syncAutoIdentity();
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
  _lastCookieString = null;
  _lastCookieSession = null;
  clearIdentitySource(AUTO_SOURCE);
  clearIdentitySource(CONNECTED_SOURCE);
}
