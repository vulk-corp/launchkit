/**
 * Session replay module — rrweb recording + chunked upload.
 *
 * Dynamically imports rrweb so the bundle is not included until replay is
 * enabled. Buffers events and flushes on a periodic timer via fetch (the
 * compressed path, no size cap), eagerly on any FullSnapshot or once the
 * buffer passes FLUSH_SOFT_MAX_BYTES. Page hidden and pagehide both drain the
 * residual through the synchronous sendBeacon path: hidden is the last event
 * a dying page reliably fires, and only a body already handed to the browser
 * survives it. A periodic FullSnapshot checkout bounds how much footage any
 * undelivered chunk can strand. Stops recording on 429 (daily cap reached).
 *
 * Session rotation: if no rrweb events fire for longer than IDLE_TIMEOUT_MS,
 * the SDK rotates to a fresh session id, flushes the tail of the old one under
 * its original identity, and forces a new FullSnapshot so the new session is
 * independently replayable.
 */

import type { eventWithTime, record as rrwebRecord } from 'rrweb';
import { gzipSync } from 'fflate';
import { setReplaySessionId } from './session-state';
import { sendTelemetry } from './telemetry-sender';
import { getVisitorId } from './visitor-state';
import { generateUuid } from './uuid';
import { backstampQueuedErrors, unstampQueuedErrors } from './error-capture';

declare const __SDK_VERSION__: string;

const SDK_TAG = '[@bworlds/launchkit]';
const FLUSH_INTERVAL_MS = 10_000;
const MAX_CHUNK_BYTES = 512_000; // 512 KB per chunk
const GZIP_MIN_BYTES = 64 * 1024;
// Flush the buffer on capture once it passes this size instead of waiting for the
// periodic timer, so a heavy in-session batch leaves via the compressed fetch path
// and never accumulates into the unload residual. Sized against the browser's
// ~64 KiB in-flight budget shared by every sendBeacon and keepalive body of one
// unload: 256 KB raw gzips to roughly 20-30 KB, so even a residual capped here
// leaves room for its sibling chunks and the diagnostics flushed alongside it.
const FLUSH_SOFT_MAX_BYTES = 262_144;
// navigator.sendBeacon (and fetch keepalive) reject bodies above 64 KiB (65536).
// Deliver a residual up to this ceiling — just under the hard limit to leave room
// for the browser's own accounting — at pagehide. The gate applies to the wire
// body, gzipped by _beaconRequestBody; only a residual still above the cap after
// compression is dropped.
const BEACON_MAX_BYTES = 64_000;
// One page shares a single ~64 KiB in-flight budget across every sendBeacon and
// keepalive body it queues at unload. Replay chunks spend at most this much of
// it, so the loss-report diagnostic and the sibling telemetry flushes
// (errors, console/network events) still fit inside the browser's cap.
const BEACON_UNLOAD_BUDGET_BYTES = 57_000;
// A replay is only recoverable from its most recent FullSnapshot: a periodic
// checkout bounds what any lost chunk can take down to one interval. Skipped
// while the tab is hidden or no event fired since the previous checkout — a
// snapshot of an unchanged DOM adds bytes without adding a recovery point.
const FULL_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const REPLAY_EVENTS_PATH = '/api/telemetry/replay-events';
const REPLAY_DIAGNOSTICS_PATH = '/api/telemetry/replay-diagnostics';
const GZIP_ENCODING = 'gzip';
const JSON_CONTENT_TYPE = 'application/json';
// sendBeacon carries no headers, so a gzipped beacon body signals compression
// through this query param and ships as text/plain — a CORS-safelisted content
// type that keeps the unload beacon preflight-free.
const BEACON_GZIP_QUERY = '?compression=gzip';
const TEXT_PLAIN_CONTENT_TYPE = 'text/plain';
// A session video is only replayable once its first chunk (the FullSnapshot) lands.
// Retry that bootstrap chunk a bounded number of times, then keep collecting the
// session as telemetry-only so the backend can still surface non-video data.
const FIRST_CHUNK_MAX_ATTEMPTS = 5;
const FIRST_CHUNK_BACKOFF_BASE_MS = FLUSH_INTERVAL_MS;
const FIRST_CHUNK_BACKOFF_MAX_MS = 5 * 60 * 1000;
// rrweb slimDOMOptions: each `true` strips that node from the FullSnapshot, it
// is not an "enable" toggle. These are head metadata and inert scripts that the
// replay never renders, so dropping them at serialization shrinks the snapshot
// before gzip without losing any visual fidelity.
const REPLAY_SLIM_DOM_OPTIONS = {
  script: true,
  comment: true,
  headFavicon: true,
  headWhitespace: true,
  headMetaSocial: true,
  headMetaRobots: true,
  headMetaHttpEquiv: true,
  headMetaVerification: true,
} as const;
// Align with Sentry Replay: a user returning within 15 minutes continues the
// same replay session. Server-side assembly is independent and append-only.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SESSION_MS = 60 * 60 * 1000; // 60 min — rotate session after this duration
const STORAGE_KEY = 'bworlds-replay-session';
const BOOTSTRAP_STORAGE_KEY = 'bworlds-replay-bootstrap-chunk';
const TOKEN_COOKIE = 'bworlds_token';
// Stable wire contract — the backend distiller will match on this tag to append
// SPA route changes to a session's pages_visited. Backend wiring is in progress
// (#889 workstream 3); until it ships the distiller still reads page from the
// type-4 Meta event only. Do not rename.
const NAVIGATION_TAG = 'navigation';
const LINK_ACTIVATION_TAG = 'link_activation';
const GLOBAL_REPLAY_STATE_KEY = '__bworldsLaunchKitReplayState__';
const VITE_DEV_CLIENT_SCRIPT_SELECTOR = 'script[src*="/@vite/client"]';
const VITE_DEV_CSS_SELECTOR = 'style[data-vite-dev-id]';
const VITE_DEV_CSS_READY_TIMEOUT_MS = 1_500;

let _sessionId: string | null = null;
let _sequenceNumber = 0;
let _sessionStartedAt = 0;
let _lastEventAt = 0;
let _eventBuffer: eventWithTime[] = [];
let _bufferedBytes = 0;
let _pendingChunks: ReplayChunk[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _snapshotTimer: ReturnType<typeof setInterval> | null = null;
let _lastPeriodicSnapshotAt = 0;
let _stopRecording: (() => void) | null = null;
let _record: typeof rrwebRecord | null = null;
let _capReached = false;
let _flushing = false;
let _starting = false;
let _buildSlug: string | null = null;
let _apiEndpoint: string | null = null;
let _visibilityHandler: (() => void) | null = null;
let _pagehideHandler: (() => void) | null = null;
// Navigation watcher: captured originals to restore on teardown, popstate
// handler ref for removeEventListener, and the last emitted URL for dedup.
let _navOriginalPushState: History['pushState'] | null = null;
let _navOriginalReplaceState: History['replaceState'] | null = null;
let _navPopstateHandler: (() => void) | null = null;
let _lastNavigationUrl: string | null = null;
let _linkClickHandler: ((event: MouseEvent) => void) | null = null;
// Cached from dynamic import so _hasErrors can use it at flush time
let _EventType: {
  Custom: number;
  FullSnapshot?: number;
  IncrementalSnapshot?: number;
} | null = null;
// UA captured once on startReplay() — sent only on first chunk
let _userAgent: string | null = null;
let _firstChunkAcked = false;
let _firstChunkAttempts = 0;
let _firstChunkRetryAfter = 0;
const _chunkFailureAttempts = new Map<string, number>();
let _enableReplayDiagnostics = true;
let _onStopped: (() => void) | null = null;
let _viteDevCssFullSnapshotSeen = false;
let _viteDevCssSnapshotRetryScheduled = false;
const _instanceId = generateUuid();

type Identity = { email: string | null; userId: string | null };
type GetIdentity = () => Identity;

const _defaultGetIdentity: GetIdentity = () => ({ email: null, userId: null });
let _getIdentity: GetIdentity = _defaultGetIdentity;

export interface StartReplayOptions {
  getIdentity?: GetIdentity;
  enableReplayDiagnostics?: boolean;
  // Invoked whenever recording stops — manual stop, idle teardown, or the 429
  // daily-cap stop that runs inside this module. The orchestrator wires it to
  // tear down the console/network telemetry wrappers it installed alongside
  // recording; passing a callback (rather than importing the telemetry module
  // here) keeps a single wrapper instance under CDN bundle splitting.
  onStopped?: () => void;
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

interface StoredBootstrapChunk {
  buildSlug: string;
  apiEndpoint: string;
  sessionId: string;
  sequenceNumber: 0;
  events: eventWithTime[];
  createdAt: number;
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

type LinkActivationElement = HTMLAnchorElement | HTMLAreaElement;

interface LinkActivationPayload {
  href: string;
  currentHref: string;
  target?: string;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  download: boolean;
  sameOrigin: boolean;
  sameDocument: boolean;
  sourceEventAtMs: number;
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
        // rrweb throws if called outside an active recording.
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

function _approxEventBytes(event: eventWithTime): number {
  // UTF-16 length, not exact UTF-8 bytes: enough for a soft flush threshold and
  // O(1) per emit instead of re-serializing the whole buffer on every event.
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}

function _sumEventBytes(events: eventWithTime[]): number {
  let total = 0;
  for (const event of events) total += _approxEventBytes(event);
  return total;
}

function _bufferEvent(event: eventWithTime): void {
  _eventBuffer.push(event);
  _bufferedBytes += _approxEventBytes(event);
}

function _drainEventBuffer(): eventWithTime[] {
  const events = _eventBuffer.splice(0);
  _bufferedBytes = 0;
  return events;
}

function _requeueEvents(events: eventWithTime[]): void {
  _eventBuffer.unshift(...events);
  _bufferedBytes = _sumEventBytes(_eventBuffer);
}

/**
 * Flush on capture, ahead of the periodic timer, when the buffer holds a heavy
 * payload. A FullSnapshot is rrweb's largest single event (~200-480 KB) and rrweb
 * re-checkouts one when the page is hidden; routing it through the compressed
 * fetch path here keeps it out of the unload beacon, which caps near 64 KiB. The
 * byte gate does the same for a burst of heavy mutations.
 */
function _shouldFlushEagerly(event: eventWithTime): boolean {
  return _isFullSnapshotEvent(event) || _bufferedBytes >= FLUSH_SOFT_MAX_BYTES;
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

function _removeStoredBootstrapChunk(): void {
  try {
    sessionStorage.removeItem(BOOTSTRAP_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable. Not fatal.
  }
}

function _loadStoredBootstrapChunk(now = Date.now()): StoredBootstrapChunk | null {
  try {
    const raw = sessionStorage.getItem(BOOTSTRAP_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredBootstrapChunk>;
    const events = stored.events;
    const hasMatchingContext =
      stored.buildSlug === _buildSlug && stored.apiEndpoint === _apiEndpoint;
    if (
      !hasMatchingContext ||
      typeof stored.sessionId !== 'string' ||
      stored.sequenceNumber !== 0 ||
      !Array.isArray(events) ||
      !_hasFullSnapshot(events as eventWithTime[]) ||
      typeof stored.createdAt !== 'number' ||
      now - stored.createdAt >= IDLE_TIMEOUT_MS
    ) {
      _removeStoredBootstrapChunk();
      return null;
    }
    return stored as StoredBootstrapChunk;
  } catch {
    _removeStoredBootstrapChunk();
    return null;
  }
}

function _saveStoredBootstrapChunk(chunk: ReplayChunk): void {
  if (chunk.sequenceNumber !== 0 || !_buildSlug || !_apiEndpoint) return;
  try {
    const stored: StoredBootstrapChunk = {
      buildSlug: _buildSlug,
      apiEndpoint: _apiEndpoint,
      sessionId: chunk.sessionId,
      sequenceNumber: 0,
      events: chunk.events,
      createdAt: Date.now(),
    };
    sessionStorage.setItem(BOOTSTRAP_STORAGE_KEY, JSON.stringify(stored));
    _sendReplayDiagnostic('bootstrap_reserved', chunk.sessionId, 'info', {
      sequenceNumber: 0,
      eventCount: chunk.events.length,
      hasFullSnapshot: _hasFullSnapshot(chunk.events),
    });
  } catch {
    // Bootstrap persistence is a durability upgrade; capture stays fail-open.
  }
}

function _clearStoredBootstrapChunk(sessionId?: string): void {
  try {
    if (sessionId) {
      const stored = _loadStoredBootstrapChunk();
      if (stored && stored.sessionId !== sessionId) return;
    }
    _removeStoredBootstrapChunk();
  } catch {
    // sessionStorage unavailable. Not fatal.
  }
}

function _restoreStoredBootstrapChunk(): boolean {
  if (!_sessionId || _firstChunkAcked) return false;
  const stored = _loadStoredBootstrapChunk();
  if (!stored || stored.sessionId !== _sessionId) return false;
  const isAlreadyQueued = _pendingChunks.some(
    (chunk) => chunk.sessionId === stored.sessionId && chunk.sequenceNumber === 0,
  );
  if (!isAlreadyQueued) {
    _pendingChunks.unshift({
      sessionId: stored.sessionId,
      sequenceNumber: 0,
      events: stored.events,
    });
  }
  _sendReplayDiagnostic('stored_bootstrap_restored', stored.sessionId, 'info', {
    sequenceNumber: 0,
    eventCount: stored.events.length,
    hasFullSnapshot: _hasFullSnapshot(stored.events),
  });
  return true;
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
    // sessionStorage unavailable. Not fatal.
  }
}

function _openNewSession(now: number): void {
  _sessionId = generateUuid();
  _sequenceNumber = 0;
  _sessionStartedAt = now;
  _firstChunkAcked = false;
  _firstChunkAttempts = 0;
  _firstChunkRetryAfter = 0;
  setReplaySessionId(_sessionId);
  _saveSession();
  _sendReplayDiagnostic('session_started', _sessionId, 'info');
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
  const storedBootstrap = _loadStoredBootstrapChunk(now);

  if (stored) {
    const idleMs = now - stored.lastActivityAt;
    const ageMs = now - stored.startedAt;

    if (idleMs < IDLE_TIMEOUT_MS && ageMs < MAX_SESSION_MS) {
      if (stored.firstChunkAcked !== true && storedBootstrap?.sessionId === stored.id) {
        _sessionId = stored.id;
        _sequenceNumber = Math.max(stored.seq, 1);
        _sessionStartedAt = stored.startedAt;
        _firstChunkAcked = false;
        setReplaySessionId(_sessionId);
        _sendReplayDiagnostic('session_resumed', _sessionId, 'info');
        return false;
      }
      if (stored.seq > 0 && stored.firstChunkAcked !== true) {
        _sendReplayDiagnostic('stored_bootstrap_missing', stored.id, 'warning', {
          reason: 'missing_stored_bootstrap',
        });
        _openNewSession(now);
        return true;
      }
      _sessionId = stored.id;
      _sequenceNumber = stored.seq;
      _sessionStartedAt = stored.startedAt;
      _firstChunkAcked = stored.firstChunkAcked === true;
      setReplaySessionId(_sessionId);
      _sendReplayDiagnostic('session_resumed', _sessionId, 'info');
      return false;
    }
  }

  if (storedBootstrap) {
    _sessionId = storedBootstrap.sessionId;
    _sequenceNumber = 1;
    _sessionStartedAt = storedBootstrap.createdAt;
    _firstChunkAcked = false;
    setReplaySessionId(_sessionId);
    _saveSession();
    _sendReplayDiagnostic('session_resumed', _sessionId, 'info');
    return false;
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

/** Decode a JWT payload without verifying the signature. Null when malformed. */
function _decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const binary = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The bworlds_token cookie and its email claim, but only when the JWT is bound
 * to the current build (its `buildSlug` claim equals `_buildSlug`).
 *
 * A bworlds_token issued for another build can share this app's cookie jar
 * (localhost ports in dev, or a parent-scoped cookie). Trusting it blindly would
 * stamp that build's user email onto this app's sessions; the server re-verifies
 * the signature, but only after the email has already shipped. The email claim is
 * read without verification, so the server still tags it 'sdk_unverified'.
 */
function _readBuildBoundToken(): { token: string; email: string | null } | null {
  const token = _readToken();
  if (!token) return null;
  const payload = _decodeJwtPayload(token);
  if (!payload || payload['buildSlug'] !== _buildSlug) return null;
  const email = payload['email'];
  return {
    token,
    email: typeof email === 'string' && email.length > 0 ? email : null,
  };
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

function _dropInitialIncrementalPreamble(events: eventWithTime[]): eventWithTime[] {
  const fullSnapshotType = _EventType?.FullSnapshot ?? 2;
  const incrementalType = _EventType?.IncrementalSnapshot ?? 3;
  const fullSnapshotIndex = events.findIndex(
    (event) => event.type === fullSnapshotType,
  );
  if (fullSnapshotIndex <= 0) return events;

  const filtered = events.filter(
    (event, index) => index >= fullSnapshotIndex || event.type !== incrementalType,
  );
  return filtered.length === events.length ? events : filtered;
}

function _buildPayload(
  events: eventWithTime[],
  sessionId: string,
  sequenceNumber: number,
  isFirstChunk: boolean,
  uploadMetadata?: ReplayUploadMetadata,
): Record<string, unknown> {
  // Only a token bound to this build is trusted: a foreign bworlds_token sharing
  // the cookie jar must not leak another build's user into this app's sessions.
  const buildToken = _readBuildBoundToken();
  const token = buildToken?.token ?? null;

  // Identity: prefer explicitly set identity, fall back to the bound token email.
  let { email, userId } = _getIdentity();
  if (!email) {
    email = buildToken?.email ?? null;
  }

  // Sent on every chunk, identified or not. visitor-state.ts owns the rationale.
  const visitorId = getVisitorId();

  return {
    buildSlug: _buildSlug,
    sessionId,
    sequenceNumber,
    isFirstChunk,
    sdkVersion: _sdkVersion(),
    eventCount: uploadMetadata?.eventCount ?? events.length,
    hasFullSnapshot: uploadMetadata?.hasFullSnapshot ?? _hasFullSnapshot(events),
    ...(uploadMetadata && {
      transport: uploadMetadata.transport,
      rawBytes: uploadMetadata.rawBytes,
    }),
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
  // Measure the payload with the upload metadata _serializeChunk adds later
  // (transport + rawBytes), otherwise a chunk just under the cap here grows past
  // it during serialization and _postChunk drops it as too large. rawBytes is not
  // yet known; MAX_CHUNK_BYTES over-reserves its digit count, and 'beacon' is the
  // longest transport label, keeping this an upper bound on the sent size.
  const body = JSON.stringify(
    _buildPayload(events, sessionId, sequenceNumber, isFirst, {
      transport: 'beacon',
      rawBytes: MAX_CHUNK_BYTES,
      eventCount: events.length,
      hasFullSnapshot: _hasFullSnapshot(events),
    }),
  );
  return new TextEncoder().encode(body).byteLength;
}

function _splitPoint(events: eventWithTime[], sequenceNumber: number): number {
  let mid = Math.floor(events.length / 2);
  if (sequenceNumber === 0) {
    const fullSnapshotIndex = events.findIndex(
      (event) => event.type === (_EventType?.FullSnapshot ?? 2),
    );
    if (fullSnapshotIndex >= mid) {
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

  if (firstSequenceNumber === 0) {
    const fullSnapshotIndex = events.findIndex(
      (event) => event.type === (_EventType?.FullSnapshot ?? 2),
    );
    if (fullSnapshotIndex >= 0) {
      const bootstrapEnd = fullSnapshotIndex + 1;
      const bootstrapChunk = {
        sessionId,
        sequenceNumber: firstSequenceNumber,
        events: events.slice(0, bootstrapEnd),
      };
      if (bootstrapEnd >= events.length) return [bootstrapChunk];
      return [
        bootstrapChunk,
        ..._planChunks(events.slice(bootstrapEnd), sessionId, firstSequenceNumber + 1),
      ];
    }
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

  const normalizedEvents =
    _sequenceNumber === 0 ? _dropInitialIncrementalPreamble(events) : events;
  const planned = _planChunks(normalizedEvents, sessionId, _sequenceNumber);
  const firstSequenceNumber = _reserveSequenceRange(sessionId, planned.length);
  if (firstSequenceNumber === null) return null;

  const chunks =
    firstSequenceNumber === planned[0]?.sequenceNumber
      ? planned
      : _planChunks(normalizedEvents, sessionId, firstSequenceNumber);
  if (chunks[0]?.sequenceNumber === 0) {
    _saveStoredBootstrapChunk(chunks[0]);
  }
  return chunks;
}

type ReplayChunkDiagnosticReason =
  | 'http_retry'
  | 'network_retry'
  | 'body_too_large'
  | 'beacon_body_too_large'
  | 'beacon_not_queued'
  | 'unload_budget_exhausted'
  | 'retry_budget_exhausted'
  | 'missing_stored_bootstrap';

type ReplayLifecycleDiagnosticType =
  | 'session_started'
  | 'session_resumed'
  | 'recorder_started'
  | 'bootstrap_reserved'
  | 'bootstrap_upload_attempt'
  | 'bootstrap_upload_ok'
  | 'bootstrap_upload_failed'
  | 'chunk_upload_attempt'
  | 'chunk_upload_ok'
  | 'chunk_upload_failed'
  | 'beacon_queued'
  | 'beacon_not_queued'
  | 'unload_chunks_dropped'
  | 'stored_bootstrap_restored'
  | 'stored_bootstrap_missing'
  | 'recorder_stopped';

type ReplayDiagnosticSeverity = 'info' | 'warning' | 'error';
type ReplayTransport = 'fetch' | 'beacon';

type UploadResult =
  | { status: 'ok'; details?: ReplayChunkDiagnosticDetails }
  | ({ status: 'retry' | 'dropped' } & ReplayChunkDiagnosticDetails);

type ReplayChunkDiagnosticDetails = {
  reason?: ReplayChunkDiagnosticReason;
  httpStatus?: number;
  rawBytes: number;
  compressedBytes: number | null;
  transport: ReplayTransport;
  hasFullSnapshot: boolean;
  eventCount: number;
};

type ReplayRequestBody = {
  body: BodyInit;
  bodyBytes: number;
  headers: Record<string, string>;
};

type ReplayUploadMetadata = {
  transport: ReplayTransport;
  rawBytes: number | null;
  eventCount: number;
  hasFullSnapshot: boolean;
};

type SerializedChunk = {
  payload: string;
  bytes: Uint8Array<ArrayBuffer>;
  rawBytes: number;
};

function _serializeChunk(
  chunk: ReplayChunk,
  transport: ReplayTransport,
): SerializedChunk {
  const isFirst = chunk.sequenceNumber === 0;
  let rawBytes: number | null = null;
  let payload = '';
  let bytes = new Uint8Array() as Uint8Array<ArrayBuffer>;
  // The payload reports transport + rawBytes but never compressedBytes: gzip runs
  // on this JSON after it is built, so the compressed size cannot be embedded in
  // it. The backend derives it from the gzipped request's own byte length, and
  // the diagnostics channel reports it out of band.
  for (let i = 0; i < 3; i += 1) {
    payload = JSON.stringify(
      _buildPayload(chunk.events, chunk.sessionId, chunk.sequenceNumber, isFirst, {
        transport,
        rawBytes,
        eventCount: chunk.events.length,
        hasFullSnapshot: _hasFullSnapshot(chunk.events),
      }),
    );
    bytes = new TextEncoder().encode(payload) as Uint8Array<ArrayBuffer>;
    if (rawBytes === bytes.byteLength) break;
    rawBytes = bytes.byteLength;
  }
  return { payload, bytes, rawBytes: bytes.byteLength };
}

function _sdkVersion(): string {
  return typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : 'unknown';
}

function _compressedBytes(requestBody: ReplayRequestBody): number | null {
  return requestBody.headers['Content-Encoding'] === GZIP_ENCODING
    ? requestBody.bodyBytes
    : null;
}

function _replayChunkDiagnosticDetails(
  chunk: ReplayChunk,
  rawBytes: number,
  compressedBytes: number | null,
  transport: ReplayTransport,
  reason?: ReplayChunkDiagnosticReason,
  httpStatus?: number,
): ReplayChunkDiagnosticDetails {
  return {
    ...(reason && { reason }),
    ...(httpStatus !== undefined && { httpStatus }),
    rawBytes,
    compressedBytes,
    transport,
    hasFullSnapshot: _hasFullSnapshot(chunk.events),
    eventCount: chunk.events.length,
  };
}

function _chunkFailureKey(chunk: ReplayChunk): string {
  return `${chunk.sessionId}:${chunk.sequenceNumber}`;
}

function _nextChunkFailureAttempt(chunk: ReplayChunk): number {
  const key = _chunkFailureKey(chunk);
  const attempt = (_chunkFailureAttempts.get(key) ?? 0) + 1;
  _chunkFailureAttempts.set(key, attempt);
  return attempt;
}

function _clearChunkFailureAttempt(chunk: ReplayChunk): void {
  _chunkFailureAttempts.delete(_chunkFailureKey(chunk));
}

function _nextDiagnosticAttempt(chunk: ReplayChunk): number {
  return chunk.sequenceNumber === 0 && chunk.sessionId === _sessionId
    ? _firstChunkAttempts + 1
    : _nextChunkFailureAttempt(chunk);
}

function _shouldSendReplayChunkDiagnostic(
  chunk: ReplayChunk,
  attempt: number,
  reason?: ReplayChunkDiagnosticReason,
): boolean {
  if (chunk.sequenceNumber === 0) return true;
  if (reason !== 'http_retry' && reason !== 'network_retry') return true;
  return attempt === 1 || attempt === 3 || attempt === 5 || attempt % 10 === 0;
}

function _chunkDiagnosticType(
  chunk: ReplayChunk,
  phase: 'attempt' | 'ok' | 'failed',
): ReplayLifecycleDiagnosticType {
  const prefix = chunk.sequenceNumber === 0 ? 'bootstrap' : 'chunk';
  return `${prefix}_upload_${phase}` as ReplayLifecycleDiagnosticType;
}

function _sendReplayDiagnostic(
  type: ReplayLifecycleDiagnosticType,
  sessionId: string,
  severity: ReplayDiagnosticSeverity,
  details: Partial<ReplayChunkDiagnosticDetails> & {
    sequenceNumber?: number;
    attempt?: number;
    reason?: ReplayChunkDiagnosticReason;
  } = {},
): void {
  if (!_buildSlug || !_enableReplayDiagnostics) return;
  sendTelemetry(REPLAY_DIAGNOSTICS_PATH, {
    buildSlug: _buildSlug,
    diagnostics: [
      {
        type,
        sessionId,
        sdkVersion: _sdkVersion(),
        capturedAt: Date.now(),
        severity,
        ...details,
      },
    ],
  });
}

function _sendReplayChunkDiagnostic(
  chunk: ReplayChunk,
  attempt: number,
  details: ReplayChunkDiagnosticDetails,
  phase: 'attempt' | 'ok' | 'failed',
): void {
  if (!_shouldSendReplayChunkDiagnostic(chunk, attempt, details.reason)) return;
  _sendReplayDiagnostic(
    _chunkDiagnosticType(chunk, phase),
    chunk.sessionId,
    phase === 'failed' ? 'warning' : 'info',
    {
      sequenceNumber: chunk.sequenceNumber,
      attempt,
      reason: details.reason,
      httpStatus: details.httpStatus,
      rawBytes: details.rawBytes,
      compressedBytes: details.compressedBytes,
      transport: details.transport,
      hasFullSnapshot: details.hasFullSnapshot,
      eventCount: details.eventCount,
    },
  );
}

async function _gzipBody(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer | null> {
  const CompressionStreamCtor = globalThis.CompressionStream;
  if (!CompressionStreamCtor) return null;

  try {
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new CompressionStreamCtor(GZIP_ENCODING));
    return await new Response(stream).arrayBuffer();
  } catch {
    return null;
  }
}

function _rawRequestBody(serialized: SerializedChunk): ReplayRequestBody {
  return {
    body: serialized.payload,
    bodyBytes: serialized.rawBytes,
    headers: { 'Content-Type': JSON_CONTENT_TYPE },
  };
}

function _chunkSizeLabel(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function _logReplayChunkDropped(
  bodyBytes: number,
  transport: 'fetch' | 'beacon',
): void {
  if (transport === 'beacon') {
    console.warn(
      `${SDK_TAG} Replay final upload is too large for unload delivery (${_chunkSizeLabel(bodyBytes)}, limit ${_chunkSizeLabel(BEACON_MAX_BYTES)}). Recent replay events may be missing.`,
    );
    return;
  }

  console.warn(
    `${SDK_TAG} Replay chunk too large (${_chunkSizeLabel(bodyBytes)}, limit ${_chunkSizeLabel(MAX_CHUNK_BYTES)}). Event dropped.`,
  );
}

/**
 * Gzip a chunk at or above GZIP_MIN_BYTES, falling back to the raw JSON string
 * when the browser lacks CompressionStream or compression fails. The caller's
 * size gate runs on bodyBytes, so a chunk too large raw but small enough
 * compressed is still sent.
 */
async function _buildReplayRequestBody(
  serialized: SerializedChunk,
): Promise<ReplayRequestBody> {
  const compressed = await _gzipBody(serialized.bytes);
  if (!compressed || compressed.byteLength >= serialized.rawBytes) {
    return _rawRequestBody(serialized);
  }

  return {
    body: compressed,
    bodyBytes: compressed.byteLength,
    headers: { 'Content-Type': JSON_CONTENT_TYPE, 'Content-Encoding': GZIP_ENCODING },
  };
}

async function _postChunk(chunk: ReplayChunk): Promise<UploadResult> {
  if (!_buildSlug || !_apiEndpoint || chunk.events.length === 0) {
    return { status: 'ok' };
  }

  const serialized = _serializeChunk(chunk, 'fetch');
  // Small chunks (the common case) keep a synchronous raw path so the upload
  // fires in the same task as the flush; only larger chunks pay the async gzip.
  const requestBody =
    serialized.rawBytes < GZIP_MIN_BYTES
      ? _rawRequestBody(serialized)
      : await _buildReplayRequestBody(serialized);

  const details = _replayChunkDiagnosticDetails(
    chunk,
    serialized.rawBytes,
    _compressedBytes(requestBody),
    'fetch',
  );

  if (requestBody.bodyBytes > MAX_CHUNK_BYTES) {
    // A single rrweb event over the transport cap even after gzip should not
    // happen in practice; surface it as an error, not routine noise.
    _logReplayChunkDropped(requestBody.bodyBytes, 'fetch');
    return {
      status: 'dropped',
      ...details,
      reason: 'body_too_large',
    };
  }

  _sendReplayChunkDiagnostic(chunk, 0, details, 'attempt');

  try {
    const resp = await fetch(`${_apiEndpoint}${REPLAY_EVENTS_PATH}`, {
      method: 'POST',
      headers: requestBody.headers,
      body: requestBody.body,
      // keepalive lets a flush that is mid-request survive the tab closing, but
      // the browser caps a keepalive body at 64 KiB — only opt in when the body
      // fits, so a large in-session chunk keeps the uncapped normal transport.
      keepalive: requestBody.bodyBytes <= BEACON_MAX_BYTES,
    });

    if (resp.status === 429) {
      _capReached = true;
      console.info(
        `${SDK_TAG} Session replay daily cap reached. Recording stopped.`,
      );
      stopReplay();
      return { status: 'ok', details }; // not retryable
    }

    if (!resp.ok) {
      console.warn(
        `${SDK_TAG} Replay chunk upload failed (HTTP ${resp.status}).`,
      );
      return {
        status: 'retry',
        ...details,
        reason: 'http_retry',
        httpStatus: resp.status,
      };
    }

    _sendReplayChunkDiagnostic(chunk, 0, details, 'ok');
    return { status: 'ok', details };
  } catch (err: unknown) {
    console.warn(
      `${SDK_TAG} Replay chunk upload failed (network error).`,
      err,
    );
    return {
      status: 'retry',
      ...details,
      reason: 'network_retry',
    };
  }
}

function _markFirstChunkAcked(chunk: ReplayChunk): void {
  if (chunk.sequenceNumber !== 0 || _sessionId !== chunk.sessionId) return;
  _firstChunkAcked = true;
  _firstChunkAttempts = 0;
  _firstChunkRetryAfter = 0;
  _clearStoredBootstrapChunk(chunk.sessionId);
  _saveSession();
}

/**
 * Open a fresh session and force a FullSnapshot so it is independently
 * replayable. Clears the navigation dedup baseline so the new session re-emits
 * its entry URL on the next route change instead of swallowing it as a duplicate
 * of the previous session's last URL.
 */
function _beginFreshSession(): void {
  _openNewSession(Date.now());
  _lastNavigationUrl = null;
  try {
    _record?.takeFullSnapshot(true);
    _lastPeriodicSnapshotAt = Date.now();
  } catch {
    // rrweb throws if called outside an active recording. Non-fatal.
  }
}

/**
 * Count a rejected attempt to deliver the session's first chunk. Returns true
 * once the retry budget is spent, so the caller can stop blocking later chunks
 * behind a video bootstrap chunk that may never land.
 */
function _registerFirstChunkFailure(): boolean {
  _firstChunkAttempts += 1;
  if (_firstChunkAttempts >= FIRST_CHUNK_MAX_ATTEMPTS) {
    console.warn(
      `${SDK_TAG} Replay session could not deliver its first chunk after ${FIRST_CHUNK_MAX_ATTEMPTS} attempts. Continuing without replay video.`,
    );
    _firstChunkAttempts = 0;
    _firstChunkRetryAfter = 0;
    return true;
  }

  const delay = Math.min(
    FIRST_CHUNK_BACKOFF_MAX_MS,
    FIRST_CHUNK_BACKOFF_BASE_MS * 2 ** (_firstChunkAttempts - 1),
  );
  _firstChunkRetryAfter = Date.now() + delay;
  return false;
}

async function _uploadReservedChunks(chunks: ReplayChunk[]): Promise<ReplayChunk[]> {
  for (let i = 0; i < chunks.length; i += 1) {
    if (_capReached) return [];
    const chunk = chunks[i];
    const result = await _postChunk(chunk);
    // First-chunk recovery only applies to the active session. An idle rotation
    // uploads the previous session's tail through here too; those failures must
    // not spend the new session's attempt budget.
    const isActiveFirstChunk =
      chunk.sequenceNumber === 0 && chunk.sessionId === _sessionId;
    if (result.status === 'retry') {
      const attempt = _nextDiagnosticAttempt(chunk);
      _sendReplayChunkDiagnostic(chunk, attempt, result, 'failed');
      if (isActiveFirstChunk && _registerFirstChunkFailure()) {
        _sendReplayChunkDiagnostic(chunk, FIRST_CHUNK_MAX_ATTEMPTS, {
          ...result,
          reason: 'retry_budget_exhausted',
        }, 'failed');
        _clearStoredBootstrapChunk(chunk.sessionId);
        continue;
      }
      return chunks.slice(i);
    }
    if (result.status === 'dropped') {
      _sendReplayChunkDiagnostic(chunk, _nextDiagnosticAttempt(chunk), result, 'failed');
      _clearChunkFailureAttempt(chunk);
      if (chunk.sequenceNumber === 0) {
        _clearStoredBootstrapChunk(chunk.sessionId);
        if (isActiveFirstChunk) {
          console.warn(
            `${SDK_TAG} Replay session is continuing without its first chunk. Replay video may be unavailable.`,
          );
        }
      }
      continue;
    }
    if (result.status === 'ok') {
      _clearChunkFailureAttempt(chunk);
      _markFirstChunkAcked(chunk);
    }
  }
  return [];
}

async function _flush(): Promise<void> {
  if (_capReached || _flushing) return;
  // Hold off while a rejected first chunk is in exponential backoff.
  if (_firstChunkRetryAfter > Date.now()) return;
  const sessionId = _sessionId;
  if (!sessionId) return;
  if (_pendingChunks.length === 0 && _eventBuffer.length === 0) return;
  _flushing = true;
  try {
    let deferredPendingChunks: ReplayChunk[] = [];
    if (_pendingChunks.length > 0) {
      const chunks = _pendingChunks.splice(0);
      const currentChunks = chunks.filter((chunk) => chunk.sessionId === sessionId);
      deferredPendingChunks = chunks.filter((chunk) => chunk.sessionId !== sessionId);
      if (currentChunks.length > 0) {
        const failed = await _uploadReservedChunks(currentChunks);
        if (_sessionId === sessionId) {
          _pendingChunks.unshift(...failed, ...deferredPendingChunks);
        }
        return;
      }
      if (_eventBuffer.length === 0) {
        const failed = await _uploadReservedChunks(deferredPendingChunks);
        if (failed.length > 0 && _sessionId === sessionId) {
          _pendingChunks.unshift(...failed);
        }
        return;
      }
    }

    const events = _drainEventBuffer();
    const chunks = _reserveChunksForEvents(events, sessionId);
    if (!chunks) {
      if (_sessionId === sessionId) {
        _requeueEvents(events);
        _pendingChunks.unshift(...deferredPendingChunks);
      }
      return;
    }

    const failed = await _uploadReservedChunks(chunks);
    if (_sessionId === sessionId) {
      _pendingChunks.unshift(...failed, ...deferredPendingChunks);
    }
  } finally {
    _flushing = false;
  }
}

type BeaconRequestBody = {
  body: BlobPart;
  bodyBytes: number;
  contentType: string;
  compressedBytes: number | null;
};

/**
 * Every beacon body is gzipped synchronously — the page is unloading, so the
 * async CompressionStream path can never complete. The browser shares one
 * ~64 KiB in-flight budget across all sendBeacon and keepalive bodies, so even
 * a chunk that fits the per-call cap raw must ship small or it starves the
 * other residuals flushed in the same unload. The cap gate runs on the wire
 * body; a raw body is kept only when gzip fails or does not shrink it.
 */
function _beaconRequestBody(serialized: SerializedChunk): BeaconRequestBody {
  const raw: BeaconRequestBody = {
    body: serialized.bytes,
    bodyBytes: serialized.rawBytes,
    contentType: JSON_CONTENT_TYPE,
    compressedBytes: null,
  };

  try {
    const compressed = gzipSync(serialized.bytes);
    if (compressed.byteLength >= serialized.rawBytes) return raw;
    return {
      body: compressed as Uint8Array<ArrayBuffer>,
      bodyBytes: compressed.byteLength,
      contentType: TEXT_PLAIN_CONTENT_TYPE,
      compressedBytes: compressed.byteLength,
    };
  } catch {
    return raw;
  }
}

type BeaconSendOutcome = {
  queued: boolean;
  bodyBytes: number;
  rawBytes: number;
};

function _beaconPostChunk(chunk: ReplayChunk, budgetRemaining: number): BeaconSendOutcome {
  if (!_buildSlug || !_apiEndpoint || chunk.events.length === 0) {
    return { queued: true, bodyBytes: 0, rawBytes: 0 };
  }

  const serialized = _serializeChunk(chunk, 'beacon');
  const requestBody = _beaconRequestBody(serialized);
  const details = _replayChunkDiagnosticDetails(
    chunk,
    serialized.rawBytes,
    requestBody.compressedBytes,
    'beacon',
  );
  const rejection = { queued: false, bodyBytes: requestBody.bodyBytes, rawBytes: serialized.rawBytes };

  if (requestBody.bodyBytes > BEACON_MAX_BYTES) {
    _logReplayChunkDropped(requestBody.bodyBytes, 'beacon');
    _sendReplayChunkDiagnostic(
      chunk,
      _nextDiagnosticAttempt(chunk),
      { ...details, reason: 'beacon_body_too_large' },
      'failed',
    );
    return rejection;
  }

  if (requestBody.bodyBytes > budgetRemaining) {
    _sendReplayChunkDiagnostic(
      chunk,
      _nextDiagnosticAttempt(chunk),
      { ...details, reason: 'unload_budget_exhausted' },
      'failed',
    );
    return rejection;
  }

  const gzipQuery = requestBody.compressedBytes === null ? '' : BEACON_GZIP_QUERY;
  const queued = navigator.sendBeacon(
    `${_apiEndpoint}${REPLAY_EVENTS_PATH}${gzipQuery}`,
    new Blob([requestBody.body], { type: requestBody.contentType }),
  );
  if (!queued) {
    _sendReplayDiagnostic('beacon_not_queued', chunk.sessionId, 'warning', {
      sequenceNumber: chunk.sequenceNumber,
      reason: 'beacon_not_queued',
      ...details,
    });
    console.warn(
      `${SDK_TAG} Replay final upload was not queued by the browser (${_chunkSizeLabel(requestBody.bodyBytes)}). Recent replay events may be missing.`,
    );
    _sendReplayChunkDiagnostic(
      chunk,
      _nextDiagnosticAttempt(chunk),
      { ...details, reason: 'beacon_not_queued' },
      'failed',
    );
  } else {
    _sendReplayDiagnostic('beacon_queued', chunk.sessionId, 'info', {
      sequenceNumber: chunk.sequenceNumber,
      ...details,
    });
    _clearChunkFailureAttempt(chunk);
  }
  return { queued, bodyBytes: requestBody.bodyBytes, rawBytes: serialized.rawBytes };
}

/**
 * Group events into chunks whose gzipped beacon body fits the per-call cap.
 * Runs BEFORE sequence reservation: a split does not burn extra numbers, and a
 * single event too large to ever ship by beacon is surfaced as dropped instead
 * of consuming a doomed sequence slot. The provisional sequence number only
 * shapes the serialized payload's digit width and the bootstrap split point.
 */
function _fitEventsToBeaconBodies(
  events: eventWithTime[],
  sessionId: string,
  provisionalSequenceNumber: number,
): { fitted: eventWithTime[][]; droppedEvents: eventWithTime[] } {
  const candidate = { sessionId, sequenceNumber: provisionalSequenceNumber, events };
  const body = _beaconRequestBody(_serializeChunk(candidate, 'beacon'));
  if (body.bodyBytes <= BEACON_MAX_BYTES) {
    return { fitted: [events], droppedEvents: [] };
  }
  if (events.length <= 1) {
    _logReplayChunkDropped(body.bodyBytes, 'beacon');
    return { fitted: [], droppedEvents: events };
  }
  const mid = _splitPoint(events, provisionalSequenceNumber);
  const left = _fitEventsToBeaconBodies(events.slice(0, mid), sessionId, provisionalSequenceNumber);
  const right = _fitEventsToBeaconBodies(
    events.slice(mid),
    sessionId,
    provisionalSequenceNumber + Math.max(1, left.fitted.length),
  );
  return {
    fitted: [...left.fitted, ...right.fitted],
    droppedEvents: [...left.droppedEvents, ...right.droppedEvents],
  };
}

/**
 * Beacon counterpart of _reserveChunksForEvents: same session guards and
 * bootstrap handling, but chunks are sized for the beacon cap before their
 * sequence range is reserved. Null means the session changed under us and the
 * events cannot be attributed.
 */
function _reserveBeaconChunks(
  events: eventWithTime[],
  sessionId: string,
): { chunks: ReplayChunk[]; droppedEvents: eventWithTime[] } | null {
  if (events.length === 0) return { chunks: [], droppedEvents: [] };
  if (_sequenceNumber === 0 && !_hasFullSnapshot(events)) return null;

  const normalizedEvents =
    _sequenceNumber === 0 ? _dropInitialIncrementalPreamble(events) : events;
  const { fitted, droppedEvents } = _fitEventsToBeaconBodies(
    normalizedEvents,
    sessionId,
    _sequenceNumber,
  );
  if (fitted.length === 0) return { chunks: [], droppedEvents };

  const firstSequenceNumber = _reserveSequenceRange(sessionId, fitted.length);
  if (firstSequenceNumber === null) return null;

  const chunks = fitted.map((groupEvents, index) => ({
    sessionId,
    sequenceNumber: firstSequenceNumber + index,
    events: groupEvents,
  }));
  if (chunks[0]?.sequenceNumber === 0) {
    _saveStoredBootstrapChunk(chunks[0]);
  }
  return { chunks, droppedEvents };
}

/**
 * Synchronous flush via sendBeacon for page hidden and unload. Every step up
 * to sendBeacon is synchronous, so a dying page cannot strand the residual in
 * an await the way a fetch flush can.
 */
function _beaconFlush(): void {
  if (_capReached) return;
  if (!_buildSlug || !_apiEndpoint || !_sessionId) return;
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;

  const sessionId = _sessionId;
  const chunks: ReplayChunk[] = [];

  if (_pendingChunks.length > 0) {
    // Only the active session's chunks can be delivered here; a deferred
    // other-session chunk cannot be beaconed, so it stays queued for a fetch
    // flush that only happens if the page survives.
    const pending = _pendingChunks.splice(0);
    for (const chunk of pending) {
      if (chunk.sessionId === sessionId) chunks.push(chunk);
      else _pendingChunks.push(chunk);
    }
  }

  let droppedEventCount = 0;
  let droppedRawBytes = 0;

  if (_eventBuffer.length > 0) {
    const events = _drainEventBuffer();
    const reserved = _reserveBeaconChunks(events, sessionId);
    if (reserved) {
      chunks.push(...reserved.chunks);
      droppedEventCount += reserved.droppedEvents.length;
    }
  }

  // Each chunk gets one beacon attempt against the browser's shared in-flight
  // budget, lowest sequence first — earlier footage is what playback needs to
  // stay coherent. A rejected chunk is re-queued for the fetch path: delivered
  // if the page survives (tab switch), gone with the page otherwise. Either
  // way the loss report below declares it, so a hole in the delivered stream
  // stays explainable from the diagnostics channel.
  let budgetRemaining = BEACON_UNLOAD_BUDGET_BYTES;
  let droppedChunkCount = 0;
  for (const chunk of chunks) {
    const outcome = _beaconPostChunk(chunk, budgetRemaining);
    if (outcome.queued) {
      budgetRemaining -= outcome.bodyBytes;
    } else {
      droppedChunkCount += 1;
      droppedEventCount += chunk.events.length;
      droppedRawBytes += outcome.rawBytes;
      _pendingChunks.push(chunk);
    }
  }

  if (droppedChunkCount > 0 || droppedEventCount > 0) {
    // Rides sendTelemetry's keepalive fetch: ~300 bytes, inside the slice of
    // the browser budget that BEACON_UNLOAD_BUDGET_BYTES deliberately leaves
    // free. Severity stays 'warning': a re-queued chunk may still land via
    // fetch, and assembly only degrades replay_health on 'error'.
    _sendReplayDiagnostic('unload_chunks_dropped', sessionId, 'warning', {
      reason: 'unload_budget_exhausted',
      eventCount: droppedEventCount,
      rawBytes: droppedRawBytes,
    });
  }
}

/**
 * Close the current session and open a fresh one when the emit gap exceeds
 * IDLE_TIMEOUT_MS. The next event starts from a FullSnapshot so replay assembly
 * can resume with an independently replayable session.
 *
 * Sequence:
 *   1. capture the old identity + buffered events
 *   2. open a fresh session (new id, reset seq, persist) and force a FullSnapshot
 *      so the new session is independently replayable
 *   3. fire-and-forget flush of the old tail under the old identity
 */
function _rotateSession(): void {
  if (!_record || !_sessionId) return;

  const oldEvents = _drainEventBuffer();
  const oldSessionId = _sessionId;
  const oldSeq = _sequenceNumber;

  _beginFreshSession();

  if (oldEvents.length > 0) {
    const oldChunks =
      oldSeq === 0 && !_hasFullSnapshot(oldEvents)
        ? []
        : _planChunks(oldEvents, oldSessionId, oldSeq);
    void _uploadReservedChunks(oldChunks)
      .then((failed) => {
        if (failed.length > 0) _pendingChunks.unshift(...failed);
      })
      .catch(() => {});
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


function _deferUntilClickPropagationSettles(callback: () => void): void {
  try {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(callback);
      return;
    }
    Promise.resolve().then(callback).catch(() => {});
  } catch {
    // Link activation capture is best-effort.
  }
}

function _findActivatableLink(target: EventTarget | null): LinkActivationElement | null {
  if (!(target instanceof Element)) return null;
  const link = target.closest('a[href], area[href]');
  if (!(link instanceof HTMLAnchorElement) && !(link instanceof HTMLAreaElement)) {
    return null;
  }
  return link;
}

function _hasDisabledLinkMarker(link: LinkActivationElement): boolean {
  const disabledMarker = link.closest('[disabled], [aria-disabled="true"]');
  return disabledMarker !== null && disabledMarker.contains(link);
}

function _resolvedLinkUrl(link: LinkActivationElement): URL | null {
  const rawHref = link.getAttribute('href')?.trim();
  if (!rawHref || rawHref.toLowerCase().startsWith('javascript:')) return null;

  try {
    return new URL(link.href, location.href);
  } catch {
    return null;
  }
}

function _buildLinkActivationPayload(
  link: LinkActivationElement,
  event: MouseEvent,
  sourceEventAtMs: number,
): LinkActivationPayload | null {
  try {
    if (typeof location === 'undefined' || _hasDisabledLinkMarker(link)) return null;
    const linkUrl = _resolvedLinkUrl(link);
    if (!linkUrl) return null;

    const currentUrl = new URL(location.href);
    const href = linkUrl.href;
    const currentHref = currentUrl.href;
    if (href === currentHref) return null;

    const target = link.getAttribute('target')?.trim();
    const payload: LinkActivationPayload = {
      href,
      currentHref,
      button: event.button,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      download: link.hasAttribute('download'),
      sameOrigin: linkUrl.origin === currentUrl.origin,
      sameDocument:
        linkUrl.origin === currentUrl.origin &&
        linkUrl.pathname === currentUrl.pathname &&
        linkUrl.search === currentUrl.search,
      sourceEventAtMs,
    };
    if (target) payload.target = target;
    return payload;
  } catch {
    return null;
  }
}

function _emitLinkActivation(payload: LinkActivationPayload): void {
  try {
    _record?.addCustomEvent(LINK_ACTIVATION_TAG, payload);
  } catch {
    // Link activation capture is best-effort.
  }
}

function _startLinkActivationWatcher(): void {
  if (typeof document === 'undefined') return;
  if (_isCrossOriginIframe()) return;
  if (_linkClickHandler) return;

  _linkClickHandler = (event: MouseEvent) => {
    try {
      const link = _findActivatableLink(event.target);
      if (!link) return;
      const payload = _buildLinkActivationPayload(link, event, Date.now());
      if (!payload) return;

      _deferUntilClickPropagationSettles(() => {
        if (!event.defaultPrevented) _emitLinkActivation(payload);
      });
    } catch {
      // Link activation capture is best-effort.
    }
  };

  try {
    document.addEventListener('click', _linkClickHandler, { capture: true });
  } catch {
    _linkClickHandler = null;
  }
}

function _stopLinkActivationWatcher(): void {
  try {
    if (_linkClickHandler) {
      document.removeEventListener('click', _linkClickHandler, { capture: true });
    }
  } catch {
    // ignore, cleanup is best-effort
  } finally {
    _linkClickHandler = null;
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
  const stoppedSessionId = _sessionId;
  if (stoppedSessionId) {
    _sendReplayDiagnostic('recorder_stopped', stoppedSessionId, 'info');
  }
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  if (_snapshotTimer) {
    clearInterval(_snapshotTimer);
    _snapshotTimer = null;
  }
  if (_stopRecording) {
    _stopRecording();
    _stopRecording = null;
  }
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }
  if (_pagehideHandler) {
    window.removeEventListener('pagehide', _pagehideHandler);
    _pagehideHandler = null;
  }
  _stopNavigationWatcher();
  _stopLinkActivationWatcher();
  // Reset module state so _resolveSession starts clean on next startReplay.
  // Clearing the shared session id covers manual stop and the 429 daily-cap
  // stop (which routes through stopReplay) — errors captured after this point
  // must not point at a session whose footage has ended.
  _clearStoredBootstrapChunk(_sessionId ?? undefined);
  setReplaySessionId(null);
  _sessionId = null;
  _sequenceNumber = 0;
  _sessionStartedAt = 0;
  _lastEventAt = 0;
  _eventBuffer = [];
  _bufferedBytes = 0;
  _pendingChunks = [];
  _record = null;
  _userAgent = null;
  _getIdentity = _defaultGetIdentity;
  _flushing = false;
  _starting = false;
  _firstChunkAcked = false;
  _firstChunkAttempts = 0;
  _firstChunkRetryAfter = 0;
  _chunkFailureAttempts.clear();
  _viteDevCssFullSnapshotSeen = false;
  _viteDevCssSnapshotRetryScheduled = false;
  _releaseReplayLock();
  // Recording has ended: tear down the telemetry wrappers tied to it. Runs last,
  // after state is clean, and covers the 429 daily-cap stop that never reaches
  // the orchestrator's own teardown.
  const onStopped = _onStopped;
  _onStopped = null;
  onStopped?.();
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
    _enableReplayDiagnostics = options.enableReplayDiagnostics !== false;
    _onStopped = options.onStopped ?? null;
    _buildSlug = buildSlug;
    _apiEndpoint = apiEndpoint.replace(/\/+$/, ''); // Strip trailing slashes
    const isFreshSession = _resolveSession();
    _eventBuffer = [];
    _bufferedBytes = 0;
    _pendingChunks = [];
    _capReached = false;
    _lastEventAt = 0;
    _viteDevCssFullSnapshotSeen = false;
    _viteDevCssSnapshotRetryScheduled = false;
    let shouldFlushStoredBootstrap = false;

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
    shouldFlushStoredBootstrap = _restoreStoredBootstrapChunk();

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
        _bufferEvent(event);
        if (_shouldFlushEagerly(event)) {
          _flush().catch(() => {});
        }
      },
      maskInputOptions: {
        password: true,
      },
      slimDOMOptions: REPLAY_SLIM_DOM_OPTIONS,
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
    if (_sessionId) {
      _sendReplayDiagnostic('recorder_started', _sessionId, 'info');
    }
    _markReplayRecording();
    _startNavigationWatcher();
    _startLinkActivationWatcher();

    // Recording is genuinely active: errors that fired during the replay
    // module's dynamic import are still queued (10s flush) with a null session
    // — link them to the session whose footage starts now.
    if (_sessionId) {
      backstampQueuedErrors(_sessionId);
    }

    _flushTimer = setInterval(() => {
      _flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);

    _lastPeriodicSnapshotAt = Date.now();
    _snapshotTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (_lastEventAt <= _lastPeriodicSnapshotAt) return;
      try {
        _record?.takeFullSnapshot(true);
        _lastPeriodicSnapshotAt = Date.now();
      } catch {
        // rrweb throws if called outside an active recording. Non-fatal.
      }
    }, FULL_SNAPSHOT_INTERVAL_MS);

    _visibilityHandler = () => {
      // hidden is the last event a dying page reliably fires, and any async
      // work started here (gzip, fetch) dies with it. The residual leaves
      // through the synchronous beacon path instead: sendBeacon hands the body
      // to the browser, which delivers it after the page is gone. On a tab
      // switch the page survives and recording simply continues.
      if (document.visibilityState === 'hidden') {
        _beaconFlush();
      }
    };
    _pagehideHandler = () => {
      // Deliver the residual on every pagehide, including a bfcache freeze:
      // sendBeacon does not keep the page out of bfcache, and draining the tail
      // now avoids losing it if the frozen page is later evicted without a resume.
      _beaconFlush();
    };

    document.addEventListener('visibilitychange', _visibilityHandler);
    // pagehide fires on the mobile tab-discard and bfcache navigations that
    // beforeunload misses.
    window.addEventListener('pagehide', _pagehideHandler);

    if (shouldFlushStoredBootstrap) {
      _flush().catch(() => {});
    }
  } finally {
    _starting = false;
    if (!_stopRecording) _releaseReplayLock();
  }
}
