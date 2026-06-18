/**
 * Shared replay-session state module — avoids importing replay.ts (and its
 * rrweb dependency) from error-capture.ts. replay.ts writes the active session
 * id on open/resume/rotation and clears it on stop; error-capture.ts reads it
 * at enqueue time to stamp errors with the recording they happened in.
 *
 * Stored on globalThis (mirroring identity-state) so the id stays shared when
 * CDN ESM providers split LaunchKit across multiple bundle files — a plain
 * module-level variable would hand error-capture and replay separate copies,
 * silently breaking the link on those builds.
 */

const REPLAY_SESSION_STATE_KEY = '__bworldsLaunchKitReplaySessionState__';

interface ReplaySessionState {
  id: string | null;
}

function getState(): ReplaySessionState {
  const root = globalThis as typeof globalThis & {
    [REPLAY_SESSION_STATE_KEY]?: ReplaySessionState;
  };
  root[REPLAY_SESSION_STATE_KEY] ??= { id: null };
  return root[REPLAY_SESSION_STATE_KEY];
}

export function setReplaySessionId(id: string | null): void {
  getState().id = id;
}

export function getReplaySessionId(): string | null {
  return getState().id;
}
