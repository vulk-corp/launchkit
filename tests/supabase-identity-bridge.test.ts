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
function base64UrlAuthCookie(session: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(session));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64url = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `base64-${b64url}`;
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
