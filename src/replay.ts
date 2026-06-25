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
import { setReplaySessionId } from './session-state';
import { getVisitorId } from './visitor-state';
import { generateUuid } from './uuid';
import { backstampQueuedErrors, unstampQueuedErrors } from './error-capture';

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
// Stable wire contract — the backend distiller will match on this tag to append
// SPA route changes to a session's pages_visited. Backend wiring is in progress
// (#889 workstream 3); until it ships the distiller still reads page from the
// type-4 Meta event only. Do not rename.
const NAVIGATION_TAG = 'navigation';
const GLOBAL_REPLAY_STATE_KEY = '__bworldsLaunchKitReplayState__';
const VITE_DEV_CLIENT_SCRIPT_SELECTOR = 'script[src*="/@vite/client"]';
const VITE_DEV_CSS_SELECTOR = 'style[data-vite-dev-id]';
const VITE_DEV_CSS_READY_TIMEOUT_MS = 1_500;

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
// Navigation watcher: captured originals to restore on teardown, popstate
// handler ref for removeEventListener, and the last emitted URL for dedup.
let _navOriginalPushState: History['pushState'] | null = null;
let _navOriginalReplaceState: History['replaceState'] | null = null;
let _navPopstateHandler: (() => void) | null = null;
let _lastNavigationUrl: string | null = null;
// Cached from dynamic import so _hasErrors can use it at flush time
let _EventType: { Custom: number; FullSnapshot?: number } | null = null;
// UA captured once on startReplay() — sent only on first chunk
let _userAgent: string | null = null;
let _firstChunkAcked = false;
let _viteDevCssFullSnapshotSeen = false;
let _viteDevCssSnapshotRetryScheduled = false;
const _instanceId = generateUuid();

type Identity = { email: string | null; userId: string | null };
type GetIdentity = () => Identity;

const _defaultGetIdentity: GetIdentity = () => ({ email: null, userId: null });
let _getIdentity: GetIdentity = _defaultGetIdentity;

export interface StartReplayOptions {
  getIdentity?: GetIdentity;
}

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

interface SnapshotNodeLike {
  type?: unknown;
  tagName?: unknown;
  attributes?: Record<string, unknown>;
  childNodes?: SnapshotNodeLike[];
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

function _hasViteDevCssElement(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector(VITE_DEV_CSS_SELECTOR) !== null;
}

function _isViteDevRuntime(): boolean {
  if (typeof document === 'undefined') return false;
  if (_hasViteDevCssElement()) return true;
  return document.querySelector(VITE_DEV_CLIENT_SCRIPT_SELECTOR) !== null;
}

function _nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

async function _waitForViteDevCssReady(): Promise<void> {
  if (!_isViteDevRuntime() || _hasViteDevCssElement()) return;

  await _nextPaint();
  if (!_isViteDevRuntime() || _hasViteDevCssElement()) return;

  await new Promise<void>((resolve) => {
    let done = false;
    let observer: MutationObserver | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      observer?.disconnect();
      clearTimeout(timeout);
      resolve();
    };

    const timeout = setTimeout(finish, VITE_DEV_CSS_READY_TIMEOUT_MS);

    if (typeof MutationObserver === 'undefined') return;

    observer = new MutationObserver(() => {
      if (_hasViteDevCssElement()) finish();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    if (_hasViteDevCssElement()) finish();
  });
}

function _isFullSnapshotEvent(event: eventWithTime): boolean {
  return event.type === (_EventType?.FullSnapshot ?? 2);
}

function _snapshotNodeHasViteDevCss(node: SnapshotNodeLike): boolean {
  if (
    node.type === 2 &&
    typeof node.tagName === 'string' &&
    node.tagName.toLowerCase() === 'style' &&
    node.attributes?.['data-vite-dev-id'] != null
  ) {
    return true;
  }

  return Array.isArray(node.childNodes)
    ? node.childNodes.some(_snapshotNodeHasViteDevCss)
    : false;
}

function _fullSnapshotHasViteDevCss(event: eventWithTime): boolean {
  if (!_isFullSnapshotEvent(event)) return false;
  const node = (event.data as { node?: SnapshotNodeLike } | undefined)?.node;
  return node ? _snapshotNodeHasViteDevCss(node) : false;
}

function _scheduleViteDevCssFullSnapshot(): void {
  if (_viteDevCssSnapshotRetryScheduled || !_record) return;
  _viteDevCssSnapshotRetryScheduled = true;

  _waitForViteDevCssReady()
    .then(() => _nextPaint())
    .then(() => {
      if (!_record || !_stopRecording) return;
      try {
        _record.takeFullSnapshot(true);
      } catch {
        // rrweb throws if called outside an active recording — non-fatal.
      }
    })
    .finally(() => {
      _viteDevCssSnapshotRetryScheduled = false;
    });
}

function _shouldBufferReplayEvent(event: eventWithTime): boolean {
  if (!_isFullSnapshotEvent(event) || !_isViteDevRuntime()) return true;
  if (_fullSnapshotHasViteDevCss(event)) {
    _viteDevCssFullSnapshotSeen = true;
    return true;
  }
  if (!_viteDevCssFullSnapshotSeen || !_hasViteDevCssElement()) return true;

  _scheduleViteDevCssFullSnapshot();
  return false;
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
  _sessionId = generateUuid();
  _sequenceNumber = 0;
  _sessionStartedAt = now;
  _firstChunkAcked = false;
  setReplaySessionId(_sessionId);
  _saveSession();
}

/**
 * Resume the stored session when still live, else open a fresh one. Returns
 * true when a FRESH session was opened: failure handling scrubs queued error
 * stamps for a fresh session (it never recorded), but keeps them for a resumed
 * session (prior footage exists).
 */
function _resolveSession(): boolean {
  const now = Date.now();
  const stored = _loadSession();

  if (stored) {
    const idleMs = now - stored.lastActivityAt;
    const ageMs = now - stored.startedAt;

    if (idleMs < IDLE_TIMEOUT_MS && ageMs < MAX_SESSION_MS) {
      if (stored.seq > 0 && stored.firstChunkAcked !== true) {
        _openNewSession(now);
        return true;
      }
      _sessionId = stored.id;
      _sequenceNumber = stored.seq;
      _sessionStartedAt = stored.startedAt;
      _firstChunkAcked = stored.firstChunkAcked === true;
      setReplaySessionId(_sessionId);
      return false;
    }
  }

  _openNewSession(now);
  return true;
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
  let { email, userId } = _getIdentity();
  if (!email) {
    email = _readCookieEmail();
  }

  // Sent on every chunk, identified or not. visitor-state.ts owns the rationale.
  const visitorId = getVisitorId();

  return {
    buildSlug: _buildSlug,
    sessionId,
    sequenceNumber,
    isFirstChunk,
    ...(token && { token }),
    events,
    hasErrors: _hasErrors(events),
    ...(visitorId && { visitorId }),
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

  // A rotated session starts a fresh page-visit timeline. Drop the dedup baseline
  // so the new session re-emits its entry URL on the next navigation, even when
  // that URL equals the prior session's last one (idle rotation would otherwise
  // swallow it as a duplicate and leave the new session with no navigation event).
  _lastNavigationUrl = null;

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

/** True when running inside a cross-origin iframe (Lovable/Bolt editor preview). */
function _isCrossOriginIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Emit a navigation custom event when the URL has actually changed. Dedup on the
 * last emitted href kills replaceState query-param churn and the no-op
 * replaceState SPAs fire on load (which would double the initial META). Reads
 * the active session id implicitly: addCustomEvent routes through rrweb's emit
 * callback, so the event lands in the current session's buffer. Never throws.
 */
function _emitNavigation(): void {
  try {
    if (!_record || typeof location === 'undefined') return;
    const href = location.href;
    if (href === _lastNavigationUrl) return;
    _lastNavigationUrl = href;

    const payload: { href: string; title?: string } = { href };
    if (typeof document !== 'undefined' && document.title) {
      payload.title = document.title;
    }
    _record.addCustomEvent(NAVIGATION_TAG, payload);
  } catch {
    // Navigation capture is best-effort — never break the host app.
  }
}

// Marker carried by our history wrappers so a re-install can recover the genuine
// original even when a prior teardown could not restore it (hardened host where
// reassigning history.pushState throws). Without it, the next install would
// capture our stale wrapper as the "original" and stack a second wrapper, firing
// every route change twice.
type NavOriginalCarrier = { __bworldsNavOriginal__?: History['pushState'] };

/**
 * Wrap one history method so it delegates to the genuine original and then emits
 * a navigation event. If the current method is already one of our wrappers, read
 * the genuine original off it instead of re-wrapping the wrapper. Returns the
 * genuine original for later restoration.
 */
function _wrapHistoryMethod(current: History['pushState']): {
  wrapper: History['pushState'];
  original: History['pushState'];
} {
  const original =
    (current as NavOriginalCarrier).__bworldsNavOriginal__ ?? current;
  const wrapper = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    original.call(this, data, unused, url);
    _emitNavigation();
  };
  (wrapper as NavOriginalCarrier).__bworldsNavOriginal__ = original;
  return { wrapper, original };
}

/**
 * Patch history.pushState/replaceState (neither fires an event natively) and
 * listen for popstate so client-side route changes are recorded as first-class
 * navigation events. Skipped in cross-origin iframes. The whole install is
 * wrapped so a hostile environment cannot break the host app's routing.
 */
function _startNavigationWatcher(): void {
  if (typeof window === 'undefined' || typeof history === 'undefined') return;
  if (_isCrossOriginIframe()) return;
  if (_navPopstateHandler) return; // already installed

  try {
    _lastNavigationUrl = typeof location !== 'undefined' ? location.href : null;

    const push = _wrapHistoryMethod(history.pushState);
    history.pushState = push.wrapper;
    _navOriginalPushState = push.original;

    const replace = _wrapHistoryMethod(history.replaceState);
    history.replaceState = replace.wrapper;
    _navOriginalReplaceState = replace.original;

    _navPopstateHandler = () => _emitNavigation();
    window.addEventListener('popstate', _navPopstateHandler);
  } catch {
    // Leave the host app's history untouched if patching failed midway.
    _stopNavigationWatcher();
  }
}

/**
 * Restore the original history methods and remove the popstate listener. Called
 * from stopReplay and as the failed-install fallback, so the host app's history
 * is never left patched once replay stops. Session rotation deliberately does NOT
 * call this — the patch must survive a rotation so navigation keeps being captured
 * in the rotated session.
 */
function _stopNavigationWatcher(): void {
  try {
    if (_navOriginalPushState) {
      history.pushState = _navOriginalPushState;
    }
    if (_navOriginalReplaceState) {
      history.replaceState = _navOriginalReplaceState;
    }
    if (_navPopstateHandler) {
      window.removeEventListener('popstate', _navPopstateHandler);
    }
  } catch {
    // ignore — restoration is best-effort
  } finally {
    _navOriginalPushState = null;
    _navOriginalReplaceState = null;
    _navPopstateHandler = null;
    _lastNavigationUrl = null;
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
  _stopNavigationWatcher();
  // Reset module state so _resolveSession starts clean on next startReplay.
  // Clearing the shared session id covers manual stop and the 429 daily-cap
  // stop (which routes through stopReplay) — errors captured after this point
  // must not point at a session whose footage has ended.
  setReplaySessionId(null);
  _sessionId = null;
  _sequenceNumber = 0;
  _sessionStartedAt = 0;
  _lastEventAt = 0;
  _eventBuffer = [];
  _pendingChunks = [];
  _record = null;
  _userAgent = null;
  _getIdentity = _defaultGetIdentity;
  _flushing = false;
  _starting = false;
  _firstChunkAcked = false;
  _viteDevCssFullSnapshotSeen = false;
  _viteDevCssSnapshotRetryScheduled = false;
  _releaseReplayLock();
}

export async function startReplay(
  buildSlug: string,
  apiEndpoint: string,
  options: StartReplayOptions = {},
): Promise<void> {
  if (_stopRecording || _starting) return; // Already recording or starting
  if (!_acquireReplayLock()) return;

  _starting = true;
  try {
    _getIdentity = options.getIdentity ?? _defaultGetIdentity;
    _buildSlug = buildSlug;
    _apiEndpoint = apiEndpoint.replace(/\/+$/, ''); // Strip trailing slashes
    const isFreshSession = _resolveSession();
    _eventBuffer = [];
    _pendingChunks = [];
    _capReached = false;
    _lastEventAt = 0;
    _viteDevCssFullSnapshotSeen = false;
    _viteDevCssSnapshotRetryScheduled = false;

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
      // _resolveSession published the session id; with no recording it must not
      // leak into error stamps (that session never assembles). A fresh session's
      // already-queued stamps are scrubbed; a resumed session keeps them.
      const failedSessionId = _sessionId;
      setReplaySessionId(null);
      if (isFreshSession && failedSessionId) {
        unstampQueuedErrors(failedSessionId);
      }
      return;
    }

    const { record, EventType } = rrweb;
    _EventType = EventType;
    _record = record;

    await _waitForViteDevCssReady();
    if (!_starting) return;

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
        if (!_shouldBufferReplayEvent(event)) return;
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
      const failedSessionId = _sessionId;
      setReplaySessionId(null);
      if (isFreshSession && failedSessionId) {
        unstampQueuedErrors(failedSessionId);
      }
      return;
    }

    _stopRecording = stop;
    _markReplayRecording();
    _startNavigationWatcher();

    // Recording is genuinely active: errors that fired during the replay
    // module's dynamic import are still queued (10s flush) with a null session
    // — link them to the session whose footage starts now.
    if (_sessionId) {
      backstampQueuedErrors(_sessionId);
    }

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
