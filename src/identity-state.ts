/**
 * Shared identity state module.
 *
 * CDN ESM providers can split LaunchKit into multiple module files. Storing the
 * identity on globalThis keeps identify() and replay payload construction on the
 * same state even when identity-state.ts is bundled into both files.
 */

const IDENTITY_STATE_KEY = '__bworldsLaunchKitIdentityState__';

interface IdentityState {
  email: string | null;
  userId: string | null;
}

function getState(): IdentityState {
  const root = globalThis as typeof globalThis & {
    [IDENTITY_STATE_KEY]?: IdentityState;
  };
  root[IDENTITY_STATE_KEY] ??= { email: null, userId: null };
  return root[IDENTITY_STATE_KEY];
}

export function setIdentity(email: string | null, userId: string | null): void {
  const state = getState();
  state.email = email;
  state.userId = userId;
}

export function resetIdentity(): void {
  const state = getState();
  state.email = null;
  state.userId = null;
}

export function getIdentity(): { email: string | null; userId: string | null } {
  const state = getState();
  return { email: state.email, userId: state.userId };
}
