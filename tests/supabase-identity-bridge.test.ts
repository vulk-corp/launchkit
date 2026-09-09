import {
  connectSupabase,
  startSupabaseIdentityBridge,
  stopSupabaseIdentityBridge,
  type SupabaseClientLike,
} from '../src/supabase-identity-bridge';
import {
  getIdentity,
  resetIdentity,
  setIdentity,
} from '../src/identity-state';

const SUPABASE_STORAGE_KEY = 'sb-abcdefghijklmnopqrst-auth-token';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

function storedSession(email = 'alice@example.com', id = 'user_123') {
  return {
    access_token: 'do-not-read',
    refresh_token: 'do-not-read',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id,
      email,
      user_metadata: { full_name: 'Alice Example' },
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Encode a session the way @supabase/ssr writes it: `base64-` + base64url(UTF-8 JSON). */
function base64UrlAuthCookie(session: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(session));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64url = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `base64-${b64url}`;
}

const CUSTOM_KEY = 'cbs_auth';
const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_USER_ID = '123e4567-e89b-42d3-a456-426614174001';

function customSession(options: {
  id?: string;
  email?: string;
  claims?: Record<string, unknown>;
} = {}) {
  const session = storedSession(options.email, options.id ?? USER_ID);
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => base64UrlAuthCookie(value).slice('base64-'.length);
  return {
    ...session,
    access_token: [
      encode({ alg: 'HS256', typ: 'JWT' }),
      encode({
        iss: 'https://example.supabase.co/auth/v1',
        sub: session.user.id,
        exp: now + 3600,
        iat: now,
        role: 'authenticated',
        ...options.claims,
      }),
      'synthetic-signature',
    ].join('.'),
    user: { ...session.user, aud: 'authenticated', role: 'authenticated' },
  };
}

function clearCookies(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0].trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
}

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  window,
  'localStorage',
);

beforeEach(() => {
  const storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  stopSupabaseIdentityBridge();
  resetIdentity();
  localStorage.clear();
  clearCookies();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  stopSupabaseIdentityBridge();
  resetIdentity();
  localStorage.clear();
  clearCookies();
  vi.unstubAllGlobals();
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(window, 'localStorage', originalLocalStorageDescriptor);
  }
  vi.useRealTimers();
});

describe.each(['localStorage', 'cookie'] as const)('custom %s sessions', (source) => {
  function write(key: string, value: unknown): void {
    if (source === 'localStorage') localStorage.setItem(key, JSON.stringify(value));
    else document.cookie = `${key}=${base64UrlAuthCookie(value)}; path=/`;
  }

  function remove(key: string): void {
    if (source === 'localStorage') localStorage.removeItem(key);
    else document.cookie = `${key}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }

  it.each(['bare', 'session', 'currentSession', 'data.session', 'double JSON', 'outer user'])(
    'discovers the %s session format', (format) => {
      const session = customSession();
      const values: Record<string, unknown> = {
        bare: session,
        session: { session },
        currentSession: { currentSession: session },
        'data.session': { data: { session } },
        'double JSON': JSON.stringify(session),
        'outer user': { user: { id: 'app-user' }, session },
      };
      write(CUSTOM_KEY, values[format]);

      startSupabaseIdentityBridge();

      expect(getIdentity()).toEqual({ email: 'alice@example.com', userId: USER_ID });
    },
  );

  it.each([
    ['iss', 'https://example.com/other'],
    ['iss', null],
    ['sub', OTHER_USER_ID],
    ['role', 'anon'],
    ['exp', 1],
    ['exp', '9999999999'],
    ['exp', null],
    ['exp', Infinity],
    ['iat', '123'],
    ['iat', null],
  ])('rejects a candidate with %s=%s', (claim, value) => {
    write(CUSTOM_KEY, customSession({ claims: { [claim as string]: value } }));

    startSupabaseIdentityBridge();

    expect(getIdentity()).toEqual({ email: null, userId: null });
  });

  it('rejects application users with a non-UUID id', () => {
    write(CUSTOM_KEY, customSession({ id: 'app-user' }));
    startSupabaseIdentityBridge();
    expect(getIdentity().userId).toBeNull();
  });

  it('requires an authenticated user audience or role', () => {
    const session = customSession();
    session.user.aud = 'anon';
    session.user.role = 'anon';
    write(CUSTOM_KEY, session);
    startSupabaseIdentityBridge();
    expect(getIdentity().userId).toBeNull();
  });

  it.each(['aud', 'role'] as const)('accepts user.%s alone', (field) => {
    const session = customSession();
    session.user.aud = '';
    session.user.role = '';
    session.user[field] = 'authenticated';
    write(CUSTOM_KEY, session);
    startSupabaseIdentityBridge();
    expect(getIdentity().userId).toBe(USER_ID);
  });

  it.each(['not-a-jwt', 'a.%%%.c', 'a.bnVsbA.c', 'a.e30.', 'a.e30.c.extra'])(
    'ignores a malformed token: %s', (access_token) => {
      write(CUSTOM_KEY, { ...customSession(), access_token });
      expect(() => startSupabaseIdentityBridge()).not.toThrow();
      expect(getIdentity().userId).toBeNull();
    },
  );

  it('uses JWT expiration instead of a stale wrapper expiration', () => {
    write(CUSTOM_KEY, { ...customSession(), expires_at: 1 });
    startSupabaseIdentityBridge();
    expect(getIdentity().userId).toBe(USER_ID);
  });

  it('prefers the latest unexpired custom candidate', () => {
    const now = Math.floor(Date.now() / 1000);
    write('old_auth', customSession({ claims: { iat: now - 100 } }));
    write('expired_auth', customSession({ claims: { iat: now + 100, exp: now - 1 } }));
    write(CUSTOM_KEY, customSession({ id: OTHER_USER_ID, claims: { iat: now - 10 } }));
    startSupabaseIdentityBridge();
    expect(getIdentity().userId).toBe(OTHER_USER_ID);
  });

  it('keeps the permissive known-key reader ahead of custom candidates', () => {
    write(CUSTOM_KEY, customSession());
    write(SUPABASE_STORAGE_KEY, { ...storedSession(), expires_at: 1 });
    startSupabaseIdentityBridge();
    expect(getIdentity().userId).toBe('user_123');
  });

  it('discovers a login after startup without a storage event', () => {
    vi.useFakeTimers();
    startSupabaseIdentityBridge();
    expect(getIdentity().userId).toBeNull();
    write(CUSTOM_KEY, customSession());
    vi.advanceTimersByTime(2_000);
    expect(getIdentity().userId).toBe(USER_ID);
  });

  it('does not reparse or expire an unchanged selected session', () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    write(CUSTOM_KEY, customSession({ claims: { exp: now + 1 } }));
    startSupabaseIdentityBridge();
    const parse = vi.spyOn(JSON, 'parse');
    vi.advanceTimersByTime(6_000);
    expect(parse).not.toHaveBeenCalled();
    expect(getIdentity().userId).toBe(USER_ID);
  });

  it('follows a changed session without checking its expiration again', () => {
    vi.useFakeTimers();
    write(CUSTOM_KEY, customSession());
    startSupabaseIdentityBridge();
    write(CUSTOM_KEY, customSession({ id: OTHER_USER_ID, claims: { exp: 1 } }));
    vi.advanceTimersByTime(2_000);
    expect(getIdentity().userId).toBe(OTHER_USER_ID);
  });

  it('keeps its key across logout and login without adopting another key', () => {
    vi.useFakeTimers();
    write(CUSTOM_KEY, customSession());
    startSupabaseIdentityBridge();
    write(SUPABASE_STORAGE_KEY, storedSession('other@example.com', 'other-user'));
    vi.advanceTimersByTime(2_000);
    expect(getIdentity().userId).toBe(USER_ID);
    remove(CUSTOM_KEY);
    vi.advanceTimersByTime(2_000);
    expect(getIdentity().userId).toBeNull();
    write(CUSTOM_KEY, customSession({ id: OTHER_USER_ID }));
    vi.advanceTimersByTime(2_000);
    expect(getIdentity().userId).toBe(OTHER_USER_ID);
  });

  it('clears malformed updates and recovers on the same key', () => {
    vi.useFakeTimers();
    write(CUSTOM_KEY, customSession());
    startSupabaseIdentityBridge();
    write(CUSTOM_KEY, { user: { id: 'unrelated-user' } });
    vi.advanceTimersByTime(2_000);
    expect(getIdentity().userId).toBeNull();
    write(CUSTOM_KEY, customSession({ id: OTHER_USER_ID }));
    vi.advanceTimersByTime(2_000);
    expect(getIdentity().userId).toBe(OTHER_USER_ID);
  });

  it('releases its selected location on stop', () => {
    write(CUSTOM_KEY, customSession());
    startSupabaseIdentityBridge();
    stopSupabaseIdentityBridge();
    remove(CUSTOM_KEY);
    write('new_auth', customSession({ id: OTHER_USER_ID }));
    startSupabaseIdentityBridge();
    expect(getIdentity().userId).toBe(OTHER_USER_ID);
  });

  it('keeps manual identity above auto detection', () => {
    write(CUSTOM_KEY, customSession());
    setIdentity('manual@example.com', 'manual-user');
    startSupabaseIdentityBridge();
    expect(getIdentity()).toEqual({ email: 'manual@example.com', userId: 'manual-user' });
  });
});

it('rejects large, tiny and unrelated values before JSON.parse', () => {
  const large = JSON.stringify({ access_token: 'x'.repeat(5 * 1024 * 1024) });
  const unrelated = JSON.stringify({ image: 'x'.repeat(1000) });
  localStorage.setItem('image', large);
  localStorage.setItem('tiny', '{"access_token":"x"}');
  localStorage.setItem('unrelated', unrelated);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSession()));
  const parse = vi.spyOn(JSON, 'parse');
  startSupabaseIdentityBridge();
  expect(parse).not.toHaveBeenCalledWith(large);
  expect(parse).not.toHaveBeenCalledWith('{"access_token":"x"}');
  expect(parse).not.toHaveBeenCalledWith(unrelated);
  expect(getIdentity().userId).toBe(USER_ID);
});

it('ignores non-JSON data that passes the cheap marker filter', () => {
  localStorage.setItem('broken', 'access_token'.repeat(30));
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSession()));
  expect(() => startSupabaseIdentityBridge()).not.toThrow();
  expect(getIdentity().userId).toBe(USER_ID);
});

it('reads only the selected localStorage key on subsequent ticks', () => {
  vi.useFakeTimers();
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSession()));
  startSupabaseIdentityBridge();
  const read = vi.spyOn(localStorage, 'getItem');
  const enumerate = vi.spyOn(localStorage, 'key');
  vi.advanceTimersByTime(4_000);
  expect(read.mock.calls).toEqual([[CUSTOM_KEY], [CUSTOM_KEY]]);
  expect(enumerate).not.toHaveBeenCalled();
});

it('examines only the changed storage key while awaiting discovery', () => {
  startSupabaseIdentityBridge();
  localStorage.setItem('unrelated', 'value');
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSession()));
  const read = vi.spyOn(localStorage, 'getItem');
  window.dispatchEvent(new StorageEvent('storage', { key: CUSTOM_KEY }));
  expect(read.mock.calls).toEqual([[CUSTOM_KEY]]);
  expect(getIdentity().userId).toBe(USER_ID);
  read.mockClear();
  window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
  expect(read).not.toHaveBeenCalled();
});

it('handles localStorage.clear from another tab', () => {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSession()));
  startSupabaseIdentityBridge();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  expect(getIdentity().userId).toBeNull();
});

it('does not throw if storage becomes unreadable', () => {
  vi.useFakeTimers();
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSession()));
  startSupabaseIdentityBridge();
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
  expect(getIdentity().userId).toBeNull();
});

it('reads a percent-encoded custom cookie with UTF-8 user data', () => {
  const session = customSession({ email: 'élise@example.com' });
  document.cookie = `${CUSTOM_KEY}=${encodeURIComponent(JSON.stringify(session))}; path=/`;
  startSupabaseIdentityBridge();
  expect(getIdentity()).toEqual({ email: 'élise@example.com', userId: USER_ID });
});

it('reassembles custom cookie chunks and follows a change to a single cookie', () => {
  vi.useFakeTimers();
  const full = base64UrlAuthCookie(customSession());
  const size = Math.ceil(full.length / 3);
  for (const index of [2, 0, 1]) {
    document.cookie = `${CUSTOM_KEY}.${index}=${full.slice(index * size, (index + 1) * size)}; path=/`;
  }
  startSupabaseIdentityBridge();
  expect(getIdentity().userId).toBe(USER_ID);
  clearCookies();
  document.cookie = `${CUSTOM_KEY}=${base64UrlAuthCookie(customSession({ id: OTHER_USER_ID }))}; path=/`;
  vi.advanceTimersByTime(2_000);
  expect(getIdentity().userId).toBe(OTHER_USER_ID);
});

it('ignores custom cookie chunks with a missing middle part', () => {
  const full = base64UrlAuthCookie(customSession());
  const mid = Math.floor(full.length / 2);
  document.cookie = `${CUSTOM_KEY}.0=${full.slice(0, mid)}; path=/`;
  document.cookie = `${CUSTOM_KEY}.2=${full.slice(mid)}; path=/`;
  startSupabaseIdentityBridge();
  expect(getIdentity().userId).toBeNull();
});

it('supports a literal custom cookie name ending in a number', () => {
  document.cookie = `custom.2=${base64UrlAuthCookie(customSession())}; path=/`;
  startSupabaseIdentityBridge();
  expect(getIdentity().userId).toBe(USER_ID);
});

it('does not reparse a selected cookie when an unrelated cookie changes', () => {
  vi.useFakeTimers();
  document.cookie = `${CUSTOM_KEY}=${base64UrlAuthCookie(customSession())}; path=/`;
  startSupabaseIdentityBridge();
  document.cookie = 'unrelated=new; path=/';
  const parse = vi.spyOn(JSON, 'parse');
  vi.advanceTimersByTime(2_000);
  expect(parse).not.toHaveBeenCalled();
  expect(getIdentity().userId).toBe(USER_ID);
});

it('ignores oversized cookies before base64 decoding', () => {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue(`custom=base64-${'a'.repeat(500_000)}`);
  const decode = vi.spyOn(globalThis, 'atob');
  startSupabaseIdentityBridge();
  expect(decode).not.toHaveBeenCalled();
  expect(getIdentity().userId).toBeNull();
});

it('prefers a custom cookie and never falls back to stale storage on logout', () => {
  vi.useFakeTimers();
  localStorage.setItem(SUPABASE_STORAGE_KEY, JSON.stringify(storedSession()));
  document.cookie = `${CUSTOM_KEY}=${base64UrlAuthCookie(customSession())}; path=/`;
  startSupabaseIdentityBridge();
  expect(getIdentity().userId).toBe(USER_ID);
  clearCookies();
  vi.advanceTimersByTime(2_000);
  expect(getIdentity().userId).toBeNull();
});

it('reads Lovable-style Supabase auth identity from localStorage', () => {
  localStorage.setItem(SUPABASE_STORAGE_KEY, JSON.stringify(storedSession()));

  startSupabaseIdentityBridge();

  expect(getIdentity()).toEqual({
    email: 'alice@example.com',
    userId: 'user_123',
  });
});

it('ignores malformed Supabase storage entries', () => {
  localStorage.setItem(SUPABASE_STORAGE_KEY, '{not-json');

  startSupabaseIdentityBridge();

  expect(getIdentity()).toEqual({ email: null, userId: null });
});

it('ignores Supabase sessions without a user id', () => {
  localStorage.setItem(
    SUPABASE_STORAGE_KEY,
    JSON.stringify({ user: { email: 'alice@example.com' } }),
  );

  startSupabaseIdentityBridge();

  expect(getIdentity()).toEqual({ email: null, userId: null });
});

it('clears auto identity when the stored session disappears', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  localStorage.setItem(SUPABASE_STORAGE_KEY, JSON.stringify(storedSession()));

  startSupabaseIdentityBridge();
  expect(getIdentity().userId).toBe('user_123');

  localStorage.removeItem(SUPABASE_STORAGE_KEY);
  vi.advanceTimersByTime(2_000);

  expect(getIdentity()).toEqual({ email: null, userId: null });
});

it('does not let auto-detected Supabase identity override manual identify()', () => {
  setIdentity('manual@example.com', 'manual_user');
  localStorage.setItem(SUPABASE_STORAGE_KEY, JSON.stringify(storedSession()));

  startSupabaseIdentityBridge();

  expect(getIdentity()).toEqual({
    email: 'manual@example.com',
    userId: 'manual_user',
  });
});

it('reads identity from a base64url auth cookie (@supabase/ssr)', () => {
  document.cookie = `${SUPABASE_STORAGE_KEY}=${base64UrlAuthCookie(
    storedSession('ssr@example.com', 'ssr_user'),
  )}`;

  startSupabaseIdentityBridge();

  expect(getIdentity()).toEqual({ email: 'ssr@example.com', userId: 'ssr_user' });
});

it('reassembles chunked auth cookies (.0/.1) into one session', () => {
  const full = base64UrlAuthCookie(storedSession('chunked@example.com', 'chunked_user'));
  const mid = Math.floor(full.length / 2);
  // Out-of-order on purpose: the reader must sort by index.
  document.cookie = `${SUPABASE_STORAGE_KEY}.1=${full.slice(mid)}`;
  document.cookie = `${SUPABASE_STORAGE_KEY}.0=${full.slice(0, mid)}`;

  startSupabaseIdentityBridge();

  expect(getIdentity()).toEqual({
    email: 'chunked@example.com',
    userId: 'chunked_user',
  });
});

it('prefers the live cookie session over a stale localStorage token', () => {
  localStorage.setItem(
    SUPABASE_STORAGE_KEY,
    JSON.stringify(storedSession('stale@example.com', 'stale_user')),
  );
  document.cookie = `${SUPABASE_STORAGE_KEY}=${base64UrlAuthCookie(
    storedSession('cookie@example.com', 'cookie_user'),
  )}`;

  startSupabaseIdentityBridge();

  expect(getIdentity()).toEqual({
    email: 'cookie@example.com',
    userId: 'cookie_user',
  });
});

it('sets no identity when no readable auth cookie or storage exists', () => {
  // An httpOnly auth cookie never appears in document.cookie, so it lands here too.
  document.cookie = 'unrelated=value';

  startSupabaseIdentityBridge();

  expect(getIdentity()).toEqual({ email: null, userId: null });
});

it('connectSupabase reads the active session and follows auth state changes', async () => {
  const authCallbacks: Array<
    (event: string, session: { user: { id: string; email: string } } | null) => void
  > = [];
  const unsubscribe = vi.fn();
  const client: SupabaseClientLike = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: storedSession('connected@example.com', 'connected_user') },
      }),
      onAuthStateChange: vi.fn((callback) => {
        authCallbacks.push(callback);
        return { data: { subscription: { unsubscribe } } };
      }),
    },
  };

  connectSupabase(client);
  await flushMicrotasks();

  expect(getIdentity()).toEqual({
    email: 'connected@example.com',
    userId: 'connected_user',
  });

  authCallbacks[0]?.('SIGNED_OUT', null);
  expect(getIdentity()).toEqual({ email: null, userId: null });

  authCallbacks[0]?.('SIGNED_IN', {
    user: { id: 'next_user', email: 'next@example.com' },
  });
  expect(getIdentity()).toEqual({
    email: 'next@example.com',
    userId: 'next_user',
  });

  stopSupabaseIdentityBridge();
  expect(unsubscribe).toHaveBeenCalled();
});
