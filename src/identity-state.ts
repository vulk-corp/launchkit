/**
 * Shared identity state module.
 *
 * CDN ESM providers can split LaunchKit into multiple module files. Storing the
 * identity on globalThis keeps identify() and replay payload construction on the
 * same state even when identity-state.ts is bundled into both files.
 */

const IDENTITY_STATE_KEY = '__bworldsLaunchKitIdentityState__';

export type IdentitySource = 'manual' | 'supabase' | 'supabase-auto';

interface IdentityValue {
  email: string | null;
  userId: string | null;
}

interface IdentityState {
  sources: Record<IdentitySource, IdentityValue>;
}

const EMPTY_IDENTITY: IdentityValue = { email: null, userId: null };
const SOURCE_ORDER: IdentitySource[] = ['manual', 'supabase', 'supabase-auto'];

function emptyIdentity(): IdentityValue {
  return { email: null, userId: null };
}

function getState(): IdentityState {
  const root = globalThis as typeof globalThis & {
    [IDENTITY_STATE_KEY]?: IdentityState | IdentityValue;
  };

  const existing = root[IDENTITY_STATE_KEY];
  if (existing && 'sources' in existing) {
    return existing;
  }

  const legacy = existing as IdentityValue | undefined;
  root[IDENTITY_STATE_KEY] = {
    sources: {
      manual: {
        email: legacy?.email ?? null,
        userId: legacy?.userId ?? null,
      },
      supabase: emptyIdentity(),
      'supabase-auto': emptyIdentity(),
    },
  };
  return root[IDENTITY_STATE_KEY];
}

export function setIdentity(email: string | null, userId: string | null): void {
  setIdentitySource('manual', email, userId);
}

export function setIdentitySource(
  source: IdentitySource,
  email: string | null,
  userId: string | null,
): void {
  const state = getState();
  state.sources[source] = { email, userId };
}

export function clearIdentitySource(source: IdentitySource): void {
  setIdentitySource(source, null, null);
}

export function resetIdentity(): void {
  const state = getState();
  for (const source of SOURCE_ORDER) {
    state.sources[source] = emptyIdentity();
  }
}

export function getIdentity(): { email: string | null; userId: string | null } {
  const state = getState();
  for (const source of SOURCE_ORDER) {
    const identity = state.sources[source] ?? EMPTY_IDENTITY;
    if (identity.email || identity.userId) {
      return { email: identity.email, userId: identity.userId };
    }
  }
  return emptyIdentity();
}
