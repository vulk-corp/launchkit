/**
 * Stable anonymous visitor id.
 *
 * A returning visitor keeps the same id across reloads, tabs, and separate
 * visits because it is persisted in localStorage. The replay payload reads it so
 * the backend can group one visitor's sessions and, once they identify, attach
 * their earlier anonymous sessions to that identity.
 *
 * Scope is the exact origin (localStorage), which keeps the id from leaking
 * between different builder apps that share a parent domain (e.g. *.lovable.app).
 *
 * Backed by globalThis like identity-state so the id stays shared when CDN ESM
 * providers split LaunchKit across bundle files. Fail-open: when localStorage is
 * unavailable (private mode, blocked), the id lives only in memory for the page's
 * lifetime and nothing throws.
 */

import { generateUuid } from './uuid';

const VISITOR_STATE_KEY = '__bworldsLaunchKitVisitorState__';
const STORAGE_KEY = 'bworlds-visitor-id';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface VisitorState {
  id: string | null;
}

function getState(): VisitorState {
  const root = globalThis as typeof globalThis & {
    [VISITOR_STATE_KEY]?: VisitorState;
  };
  root[VISITOR_STATE_KEY] ??= { id: null };
  return root[VISITOR_STATE_KEY];
}

interface StoredVisitorId {
  /** A well-formed stored id, or null when absent, malformed, or unreadable. */
  value: string | null;
  /** False only when the read threw, so the caller must not overwrite storage. */
  readable: boolean;
}

function readStoredVisitorId(): StoredVisitorId {
  try {
    if (typeof localStorage === 'undefined') return { value: null, readable: false };
    const raw = localStorage.getItem(STORAGE_KEY);
    return { value: raw && UUID_RE.test(raw) ? raw : null, readable: true };
  } catch {
    return { value: null, readable: false };
  }
}

function persistVisitorId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage unavailable: the id stays in-memory for this page only.
  }
}

/**
 * The current visitor id, generating and persisting one on first read. Returns
 * null only if the whole resolution throws, so callers can omit the field.
 */
export function getVisitorId(): string | null {
  try {
    const state = getState();
    if (state.id) return state.id;

    const { value: stored, readable } = readStoredVisitorId();
    if (stored) {
      state.id = stored;
      return stored;
    }

    // Mint a new id, but persist it only when storage was readable (the id is
    // genuinely absent or malformed). A read that threw might be hiding an
    // existing id, so overwriting it would split a returning visitor in two.
    const id = generateUuid();
    if (readable) persistVisitorId(id);
    state.id = id;
    return id;
  } catch {
    return null;
  }
}
