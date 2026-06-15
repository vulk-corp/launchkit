/**
 * Session replay module — rrweb recording + chunked upload.
 *
 * Dynamically imports rrweb so the bundle is not included until replay is
 * enabled. Buffers events and flushes every FLUSH_INTERVAL_MS or on
 * visibilitychange/beforeunload. Stops recording on 429 (daily cap reached).
 *
 * Session rotation: if no rrweb events fire for longer than IDLE_TIMEOUT_MS,
 * the SDK rotates to a fresh session id, flushes the tail of the old one under
 * its original identity, and forces a new FullSnapshot so the new session is
 * independently replayable.
 */

import type { eventWithTime, record as rrwebRecord } from 'rrweb';
import { getIdentity } from './identity-state';

const SDK_TAG = '[@bworlds/launchkit]';
const FLUSH_INTERVAL_MS = 10_000;
const MAX_CHUNK_BYTES = 512_000; // 512 KB per chunk
const REPLAY_EVENTS_PATH = '/api/telemetry/replay-events';
// Align with Sentry Replay: a user returning within 15 minutes continues the
// same replay session. Server-side assembly is independent and append-only.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SESSION_MS = 60 * 60 * 1000; // 60 min — rotate session after this duration
const STORAGE_KEY = 'bworlds-replay-session';
const TOKEN_COOKIE = 'bworlds_token';
const GLOBAL_REPLAY_STATE_KEY = '__bworldsLaunchKitReplayState__';

let _sessionId: string | null = null;
let _sequenceNumber = 0;
let _sessionStartedAt = 0;
let _lastEventAt = 0;
let _eventBuffer: eventWithTime[] = [];
let _pendingChunks: ReplayChunk[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _stopRecording: (() => void) | null = null;
let _record: typeof rrwebRecord | null = null;
let _capReached = false;
let _flushing = false;
let _starting = false;
let _buildSlug: string | null = null;
let _apiEndpoint: string | null = null;
let _visibilityHandler: (() => void) | null = null;
let _unloadHandler: (() => void) | null = null;
// Cached from dynamic import so _hasErrors can use it at flush time
let _EventType: { Custom: number; FullSnapshot?: number } | null = null;
// UA captured once on startReplay() — sent only on first chunk
let _userAgent: string | null = null;
let _firstChunkAcked = false;
const _instanceId = _generateSessionId();

interface StoredSession {
  id: string;
  seq: number;
  startedAt: number;
  lastActivityAt: number;
  firstChunkAcked?: boolean;
}

interface ReplayChunk {
  sessionId: string;
  sequenceNumber: number;
  events: eventWithTime[];
}

interface ReplayGlobalState {
  ownerId: string;
  phase: 'starting' | 'recording';
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

function _getReplayWindow(): (Window & {
  [GLOBAL_REPLAY_STATE_KEY]?: ReplayGlobalState;
}) | null {
  if (typeof window === 'undefined') return null;
  return window as Window & { [GLOBAL_REPLAY_STATE_KEY]?: ReplayGlobalState };
}

function _acquireReplayLock(): boolean {
  const replayWindow = _getReplayWindow();
  if (!replayWindow) return true;

  const existing = replayWindow[GLOBAL_REPLAY_STATE_KEY];
  if (existing && existing.ownerId !== _instanceId) return false;

  replayWindow[GLOBAL_REPLAY_STATE_KEY] = {
    ownerId: _instanceId,
    phase: 'starting',
  };
  return true;
}

function _markReplayRecording(): void {
  const replayWindow = _getReplayWindow();
  if (!replayWindow) return;
  replayWindow[GLOBAL_REPLAY_STATE_KEY] = {
    ownerId: _instanceId,
    phase: 'recording',
  };
}

function _releaseReplayLock(): void {
  const replayWindow = _getReplayWindow();
  if (!replayWindow) return;
  if (replayWindow[GLOBAL_REPLAY_STATE_KEY]?.ownerId === _instanceId) {
    delete replayWindow[GLOBAL_REPLAY_STATE_KEY];
  }
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
      firstChunkAcked: _firstChunkAcked,
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
  _firstChunkAcked = false;
  _saveSession();
}

function _resolveSession(): void {
  const now = Date.now();
  const stored = _loadSession();

  if (stored) {
    const idleMs = now - stored.lastActivityAt;
    const ageMs = now - stored.startedAt;

    if (idleMs < IDLE_TIMEOUT_MS && ageMs < MAX_SESSION_MS) {
      if (stored.seq > 0 && stored.firstChunkAcked !== true) {
        _openNewSession(now);
        return;
      }
      _sessionId = stored.id;
      _sequenceNumber = stored.seq;
      _sessionStartedAt = stored.startedAt;
      _firstChunkAcked = stored.firstChunkAcked === true;
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

/**
 * Decode the `email` claim from the bworlds_token JWT without verification.
 * This is an opportunistic read — the server re-verifies the JWT at ingest.
 * Returns null when the cookie is absent, malformed, or has no email claim.
 */
function _readCookieEmail(): string | null {
  const token = _readToken();
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    const email = payload['email'];
    return typeof email === 'string' && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

function _hasErrors(events: eventWithTime[]): boolean {
  if (!_EventType) return false;
  return events.some(
    (e) =>
      e.type === _EventType!.Custom &&
      (e.data as Record<string, unknown>)?.tag === 'error',
  );
}

function _hasFullSnapshot(events: eventWithTime[]): boolean {
  const fullSnapshotType = _EventType?.FullSnapshot ?? 2;
  return events.some((event) => event.type === fullSnapshotType);
}

function _buildPayload(
  events: eventWithTime[],
  sessionId: string,
  sequenceNumber: number,
  isFirstChunk: boolean,
): Record<string, unknown> {
  const token = _readToken();

  // Identity: prefer explicitly set identity, fall back to cookie email claim
  // (server re-verifies the token, so this is tagged 'sdk_unverified' at ingest)
  let { email, userId } = getIdentity();
  if (!email) {
    email = _readCookieEmail();
  }

  return {
    buildSlug: _buildSlug,
    sessionId,
    sequenceNumber,
    isFirstChunk,
    ...(token && { token }),
    events,
    hasErrors: _hasErrors(events),
    ...(email && { userEmail: email }),
    ...(userId && { userId }),
    // UA sent on first chunk only; omitted on subsequent chunks
    ...(isFirstChunk && _userAgent && { userAgent: _userAgent }),
  };
}

function _payloadBytes(
  events: eventWithTime[],
  sessionId: string,
  sequenceNumber: number,
): number {
  const isFirst = sequenceNumber === 0;
  const body = JSON.stringify(
    _buildPayload(events, sessionId, sequenceNumber, isFirst),
  );
  return new TextEncoder().encode(body).byteLength;
}

function _splitPoint(events: eventWithTime[], sequenceNumber: number): number {
  let mid = Math.floor(events.length / 2);
  if (sequenceNumber === 0) {
    const fullSnapshotIndex = events.findIndex(
      (event) => event.type === (_EventType?.FullSnapshot ?? 2),
    );
    if (fullSnapshotIndex >= mid && fullSnapshotIndex < events.length - 1) {
      mid = fullSnapshotIndex + 1;
    }
  }
  return Math.max(1, Math.min(mid, events.length - 1));
}

function _planChunks(
  events: eventWithTime[],
  sessionId: string,
  firstSequenceNumber: number,
): ReplayChunk[] {
  if (
    _payloadBytes(events, sessionId, firstSequenceNumber) <= MAX_CHUNK_BYTES ||
    events.length <= 1
  ) {
    return [{ sessionId, sequenceNumber: firstSequenceNumber, events }];
  }

  const mid = _splitPoint(events, firstSequenceNumber);
  const left = _planChunks(
    events.slice(0, mid),
    sessionId,
    firstSequenceNumber,
  );
  const right = _planChunks(
    events.slice(mid),
    sessionId,
    firstSequenceNumber + left.length,
  );
  return [...left, ...right];
}

function _reserveSequenceRange(sessionId: string, count: number): number | null {
  if (!_sessionId || _sessionId !== sessionId || count <= 0) return null;
  const firstSequenceNumber = _sequenceNumber;
  _sequenceNumber += count;
  _saveSession();
  return firstSequenceNumber;
}

function _reserveChunksForEvents(
  events: eventWithTime[],
  sessionId: string,
): ReplayChunk[] | null {
  if (events.length === 0) return [];
  if (_sequenceNumber === 0 && !_hasFullSnapshot(events)) return null;

  const planned = _planChunks(events, sessionId, _sequenceNumber);
  const firstSequenceNumber = _reserveSequenceRange(sessionId, planned.length);
  if (firstSequenceNumber === null) return null;

  return firstSequenceNumber === planned[0]?.sequenceNumber
    ? planned
    : _planChunks(events, sessionId, firstSequenceNumber);
}

type UploadResult = 'ok' | 'retry' | 'dropped';

async function _postChunk(chunk: ReplayChunk): Promise<UploadResult> {
  if (!_buildSlug || !_apiEndpoint || chunk.events.length === 0) return 'ok';

  const isFirst = chunk.sequenceNumber === 0;
  const body = JSON.stringify(
    _buildPayload(chunk.events, chunk.sessionId, chunk.sequenceNumber, isFirst),
  );
  const bodyBytes = new TextEncoder().encode(body).byteLength;

  if (bodyBytes > MAX_CHUNK_BYTES) {
    console.warn(
      `${SDK_TAG} Replay event too large (${(bodyBytes / 1024).toFixed(0)} KB, limit ${MAX_CHUNK_BYTES / 1024} KB). Event dropped.`,
    );
    return 'dropped'; // not retryable
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
      return 'ok'; // not retryable
    }

    if (!resp.ok) {
      console.warn(
        `${SDK_TAG} Replay chunk upload failed (HTTP ${resp.status}).`,
      );
      return 'retry';
    }

    return 'ok';
  } catch (err: unknown) {
    console.warn(
      `${SDK_TAG} Replay chunk upload failed (network error).`,
      err,
    );
    return 'retry';
  }
}

function _markFirstChunkAcked(chunk: ReplayChunk): void {
  if (chunk.sequenceNumber !== 0 || _sessionId !== chunk.sessionId) return;
  _firstChunkAcked = true;
  _saveSession();
}

async function _uploadReservedChunks(chunks: ReplayChunk[]): Promise<ReplayChunk[]> {
  for (let i = 0; i < chunks.length; i += 1) {
    if (_capReached) return [];
    const chunk = chunks[i];
    const result = await _postChunk(chunk);
    if (result === 'retry') return chunks.slice(i);
    if (result === 'ok') _markFirstChunkAcked(chunk);
  }
  return [];
}

async function _flush(_isFinal = false): Promise<void> {
  if (_capReached || _flushing) return;
  const sessionId = _sessionId;
  if (!sessionId) return;
  if (_pendingChunks.length === 0 && _eventBuffer.length === 0) return;
  _flushing = true;
  try {
    if (_pendingChunks.length > 0) {
      const chunks = _pendingChunks.splice(0);
      const currentChunks = chunks.filter(
        (chunk) => chunk.sessionId === sessionId,
      );
      const failed = await _uploadReservedChunks(currentChunks);
      if (failed.length > 0 && _sessionId === sessionId) {
        _pendingChunks.unshift(...failed);
      }
      return;
    }

    const events = _eventBuffer.splice(0);
    const chunks = _reserveChunksForEvents(events, sessionId);
    if (!chunks) {
      if (_sessionId === sessionId) {
        _eventBuffer.unshift(...events);
      }
      return;
    }

    const failed = await _uploadReservedChunks(chunks);
    if (failed.length > 0 && _sessionId === sessionId) {
      _pendingChunks.unshift(...failed);
    }
  } finally {
    _flushing = false;
  }
}

function _beaconPostChunk(chunk: ReplayChunk): boolean {
  if (!_buildSlug || !_apiEndpoint || chunk.events.length === 0) return true;

  const isFirst = chunk.sequenceNumber === 0;
  const body = JSON.stringify(
    _buildPayload(chunk.events, chunk.sessionId, chunk.sequenceNumber, isFirst),
  );
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  if (bodyBytes > MAX_CHUNK_BYTES) return false;

  return navigator.sendBeacon(
    `${_apiEndpoint}${REPLAY_EVENTS_PATH}`,
    new Blob([body], { type: 'application/json' }),
  );
}

/** Synchronous flush via sendBeacon for page unload. */
function _beaconFlush(): void {
  if (_capReached) return;
  if (!_buildSlug || !_apiEndpoint || !_sessionId) return;
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;

  const sessionId = _sessionId;
  const chunks: ReplayChunk[] = [];

  if (_pendingChunks.length > 0) {
    const pending = _pendingChunks.splice(0);
    chunks.push(...pending.filter((chunk) => chunk.sessionId === sessionId));
  }

  if (_eventBuffer.length > 0) {
    const events = _eventBuffer.splice(0);
    const reserved = _reserveChunksForEvents(events, sessionId);
    if (reserved) {
      chunks.push(...reserved);
    } else if (_sessionId === sessionId) {
      _eventBuffer.unshift(...events);
    }
  }

  const failed: ReplayChunk[] = [];
  for (const chunk of chunks) {
    if (!_beaconPostChunk(chunk)) failed.push(chunk);
  }
  if (failed.length > 0 && _sessionId === sessionId) {
    _pendingChunks.unshift(...failed);
  }
}

/**
 * Close the current session and open a fresh one when the emit gap exceeds
 * IDLE_TIMEOUT_MS. The next event starts from a FullSnapshot so replay assembly
 * can resume with an independently replayable session.
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
    const oldChunks =
      oldSeq === 0 && !_hasFullSnapshot(oldEvents)
        ? []
        : _planChunks(oldEvents, oldSessionId, oldSeq);
    _uploadReservedChunks(oldChunks).catch(() => {});
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
  _eventBuffer = [];
  _pendingChunks = [];
  _record = null;
  _userAgent = null;
  _flushing = false;
  _starting = false;
  _firstChunkAcked = false;
  _releaseReplayLock();
}

export async function startReplay(
  buildSlug: string,
  apiEndpoint: string,
): Promise<void> {
  if (_stopRecording || _starting) return; // Already recording or starting
  if (!_acquireReplayLock()) return;

  _starting = true;
  try {
    _buildSlug = buildSlug;
    _apiEndpoint = apiEndpoint.replace(/\/+$/, ''); // Strip trailing slashes
    _resolveSession();
    _eventBuffer = [];
    _pendingChunks = [];
    _capReached = false;
    _lastEventAt = 0;

    // Capture UA once per replay session — sent on first chunk only
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      _userAgent = navigator.userAgent;
    }

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
    _markReplayRecording();

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
  } finally {
    _starting = false;
    if (!_stopRecording) _releaseReplayLock();
  }
}
