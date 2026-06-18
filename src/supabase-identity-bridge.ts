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

function _syncAutoIdentity(): void {
  _applySession(AUTO_SOURCE, _readStoredSupabaseSession());
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
  if (typeof window === 'undefined' || !_getLocalStorage()) return;
  if (_autoTimer) return;

  _syncAutoIdentity();
  _storageHandler = (event: StorageEvent) => {
    if (!event.key || _looksLikeSupabaseAuthKey(event.key)) {
      _syncAutoIdentity();
    }
  };
  window.addEventListener('storage', _storageHandler);
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
  clearIdentitySource(AUTO_SOURCE);
  clearIdentitySource(CONNECTED_SOURCE);
}
