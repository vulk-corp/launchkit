/**
 * Session replay module — rrweb recording + chunked upload.
 *
 * Dynamically imports rrweb so the bundle is not included until replay is
 * enabled. Buffers events and flushes every FLUSH_INTERVAL_MS or on
 * visibilitychange/beforeunload. Stops recording on 429 (daily cap reached).
 *
 * Session rotation: if no rrweb events fire for longer than IDLE_TIMEOUT_MS,
 * the server may already have assembled the session. On the next event the
 * SDK rotates to a fresh session id, flushes the tail of the old one under
 * its original identity, and forces a new FullSnapshot so the new session is
 * independently replayable.
 */

import type { eventWithTime, record as rrwebRecord } from 'rrweb';

const SDK_TAG = '[@bworlds/launchkit]';
const FLUSH_INTERVAL_MS = 10_000;
const MAX_CHUNK_BYTES = 512_000; // 512 KB per chunk
const REPLAY_EVENTS_PATH = '/api/telemetry/replay-events';
// Must stay below the server-side idle-assembly threshold (5 min). If the SDK
// waits longer than this between events, the server will have already closed
// the session and any further chunks would be discarded as late.
const IDLE_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_SESSION_MS = 60 * 60 * 1000; // 60 min — rotate session after this duration
const STORAGE_KEY = 'bworlds-replay-session';
const TOKEN_COOKIE = 'bworlds_token';

let _sessionId: string | null = null;
let _sequenceNumber = 0;
let _sessionStartedAt = 0;
let _lastEventAt = 0;
let _eventBuffer: eventWithTime[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _stopRecording: (() => void) | null = null;
let _record: typeof rrwebRecord | null = null;
let _capReached = false;
let _flushing = false;
let _buildSlug: string | null = null;
let _apiEndpoint: string | null = null;
let _visibilityHandler: (() => void) | null = null;
let _unloadHandler: (() => void) | null = null;
// Cached from dynamic import so _hasErrors can use it at flush time
let _EventType: { Custom: number } | null = null;

interface StoredSession {
  id: string;
  seq: number;
  startedAt: number;
  lastActivityAt: number;
}

function _generateSessionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function _loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

function _saveSession(): void {
  if (!_sessionId) return;
  try {
    const data: StoredSession = {
      id: _sessionId,
      seq: _sequenceNumber,
      startedAt: _sessionStartedAt,
      lastActivityAt: Date.now(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // sessionStorage unavailable — not fatal
  }
}

function _openNewSession(now: number): void {
  _sessionId = _generateSessionId();
  _sequenceNumber = 0;
  _sessionStartedAt = now;
  _saveSession();
}

function _resolveSession(): void {
  const now = Date.now();
  const stored = _loadSession();

  if (stored) {
    const idleMs = now - stored.lastActivityAt;
    const ageMs = now - stored.startedAt;

    if (idleMs < IDLE_TIMEOUT_MS && ageMs < MAX_SESSION_MS) {
      _sessionId = stored.id;
      _sequenceNumber = stored.seq;
      _sessionStartedAt = stored.startedAt;
      return;
    }
  }

  _openNewSession(now);
}

/** Read the bworlds_token cookie (set by check module after validation). */
function _readToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([^;]+)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function _hasErrors(events: eventWithTime[]): boolean {
  if (!_EventType) return false;
  return events.some(
    (e) =>
      e.type === _EventType!.Custom &&
      (e.data as Record<string, unknown>)?.tag === 'error',
  );
}

function _buildPayload(
  events: eventWithTime[],
  sessionId: string,
  sequenceNumber: number,
): Record<string, unknown> {
  const token = _readToken();
  return {
    buildSlug: _buildSlug,
    sessionId,
    sequenceNumber,
    ...(token && { token }),
    events,
    hasErrors: _hasErrors(events),
  };
}

/**
 * POST a chunk under the given session identity. Does NOT mutate module
 * state — callers decide whether to advance `_sequenceNumber` after success.
 * This lets rotation flush the tail of an old session without corrupting the
 * new session's sequence counter.
 */
async function _flushChunk(
  events: eventWithTime[],
  sessionId: string,
  sequenceNumber: number,
): Promise<boolean> {
  if (!_buildSlug || !_apiEndpoint || events.length === 0) return true;

  const body = JSON.stringify(_buildPayload(events, sessionId, sequenceNumber));
  const bodyBytes = new TextEncoder().encode(body).byteLength;

  // Split oversized chunks recursively instead of dropping events. Each half
  // reuses the same sequenceNumber — the server dedupes on (session, seq).
  if (bodyBytes > MAX_CHUNK_BYTES && events.length > 1) {
    const mid = Math.floor(events.length / 2);
    const a = await _flushChunk(events.slice(0, mid), sessionId, sequenceNumber);
    const b = await _flushChunk(events.slice(mid), sessionId, sequenceNumber);
    return a && b;
  }

  if (bodyBytes > MAX_CHUNK_BYTES) {
    // Single event exceeds limit, nothing we can do
    console.warn(
      `${SDK_TAG} Replay event too large (${(bodyBytes / 1024).toFixed(0)} KB, limit ${MAX_CHUNK_BYTES / 1024} KB). Event dropped.`,
    );
    return true; // not retryable
  }

  try {
    const resp = await fetch(`${_apiEndpoint}${REPLAY_EVENTS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (resp.status === 429) {
      _capReached = true;
      console.info(
        `${SDK_TAG} Session replay daily cap reached. Recording stopped.`,
      );
      stopReplay();
      return true; // not retryable
    }

    if (!resp.ok) {
      console.warn(
        `${SDK_TAG} Replay chunk upload failed (HTTP ${resp.status}).`,
      );
      return false;
    }

    return true;
  } catch (err: unknown) {
    console.warn(
      `${SDK_TAG} Replay chunk upload failed (network error).`,
      err,
    );
    return false;
  }
}

async function _flush(_isFinal = false): Promise<void> {
  if (_capReached || _eventBuffer.length === 0 || _flushing) return;
  const sessionId = _sessionId;
  if (!sessionId) return;
  _flushing = true;
  try {
    const events = _eventBuffer.splice(0);
    const sequenceNumber = _sequenceNumber;
    const ok = await _flushChunk(events, sessionId, sequenceNumber);
    if (ok) {
      // Only advance if we're still on the same session — a rotation during
      // the in-flight request must not bump the new session's seq counter.
      if (_sessionId === sessionId) {
        _sequenceNumber += 1;
        _saveSession();
      }
    } else if (_sessionId === sessionId) {
      // Re-queue only when the session hasn't rotated. After rotation the
      // old session is closed server-side; retrying under new identity would
      // poison the new session's FullSnapshot ordering.
      _eventBuffer.unshift(...events);
    }
  } finally {
    _flushing = false;
  }
}

/** Synchronous flush via sendBeacon for page unload. */
function _beaconFlush(): void {
  if (_capReached || _eventBuffer.length === 0) return;
  if (!_buildSlug || !_apiEndpoint || !_sessionId) return;

  const events = _eventBuffer.splice(0);
  const body = JSON.stringify(
    _buildPayload(events, _sessionId, _sequenceNumber),
  );
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(
      `${_apiEndpoint}${REPLAY_EVENTS_PATH}`,
      new Blob([body], { type: 'application/json' }),
    );
    // Optimistic: sendBeacon is fire-and-forget, so we increment without
    // delivery confirmation. Backend must tolerate sequence gaps.
    _sequenceNumber += 1;
    _saveSession();
  }
}

/**
 * Close the current session and open a fresh one. Called from the emit
 * callback when the gap since the previous event exceeds IDLE_TIMEOUT_MS —
 * by that point the server has likely assembled the old session, so any
 * further chunks under its id would be discarded.
 *
 * Sequence:
 *   1. snapshot old identity + buffered events
 *   2. generate a new session id, reset seq, persist
 *   3. fire-and-forget flush of the old tail under the old identity
 *   4. trigger rrweb.takeFullSnapshot(true) so the new session starts with a
 *      type-2 snapshot and is independently replayable
 */
function _rotateSession(): void {
  if (!_record || !_sessionId) return;

  const oldEvents = _eventBuffer.splice(0);
  const oldSessionId = _sessionId;
  const oldSeq = _sequenceNumber;

  _openNewSession(Date.now());

  if (oldEvents.length > 0) {
    _flushChunk(oldEvents, oldSessionId, oldSeq).catch(() => {});
  }

  try {
    _record.takeFullSnapshot(true);
  } catch {
    // rrweb throws if called outside an active recording — non-fatal.
  }
}

export function stopReplay(): void {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  if (_stopRecording) {
    _stopRecording();
    _stopRecording = null;
  }
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }
  if (_unloadHandler) {
    window.removeEventListener('beforeunload', _unloadHandler);
    _unloadHandler = null;
  }
  // Reset module state so _resolveSession starts clean on next startReplay
  _sessionId = null;
  _sequenceNumber = 0;
  _sessionStartedAt = 0;
  _lastEventAt = 0;
  _record = null;
}

export async function startReplay(
  buildSlug: string,
  apiEndpoint: string,
): Promise<void> {
  if (_stopRecording) return; // Already recording
  _buildSlug = buildSlug;
  _apiEndpoint = apiEndpoint.replace(/\/+$/, ''); // Strip trailing slashes
  _resolveSession();
  _eventBuffer = [];
  _capReached = false;
  _lastEventAt = 0;

  // Dynamic import — rrweb is only loaded when replay is enabled
  let rrweb: typeof import('rrweb') | null = null;
  try {
    rrweb = await import('rrweb');
  } catch (err: unknown) {
    console.warn(
      `${SDK_TAG} Session replay failed to initialize. rrweb could not be loaded:`,
      err,
    );
    return;
  }

  const { record, EventType } = rrweb;
  _EventType = EventType;
  _record = record;

  const stop = record({
    emit(event: eventWithTime) {
      const now = Date.now();
      const shouldRotate =
        _lastEventAt > 0 && now - _lastEventAt > IDLE_TIMEOUT_MS;
      _lastEventAt = now;
      if (shouldRotate) {
        // Rotation synchronously calls takeFullSnapshot, which re-enters this
        // emit callback with a type-2 event. Updating _lastEventAt first
        // prevents that nested call from re-triggering rotation.
        _rotateSession();
      }
      _eventBuffer.push(event);
    },
    maskInputOptions: {
      password: true,
    },
    blockSelector: '[data-rrweb-block]',
    maskTextSelector: '[data-rrweb-mask]',
  });

  if (!stop) {
    console.warn(
      `${SDK_TAG} rrweb record() returned no stop handle. Replay disabled.`,
    );
    return;
  }

  _stopRecording = stop;

  _flushTimer = setInterval(() => {
    _flush().catch(() => {});
  }, FLUSH_INTERVAL_MS);

  _visibilityHandler = () => {
    if (document.visibilityState === 'hidden') {
      _flush(true).catch(() => {});
    }
  };
  _unloadHandler = () => {
    _beaconFlush();
  };

  document.addEventListener('visibilitychange', _visibilityHandler);
  window.addEventListener('beforeunload', _unloadHandler);
}
