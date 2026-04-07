/**
 * Session replay module — rrweb recording + chunked upload.
 *
 * Dynamically imports rrweb so the bundle is not included until replay is
 * enabled. Buffers events and flushes every FLUSH_INTERVAL_MS or on
 * visibilitychange/beforeunload. Stops recording on 429 (daily cap reached).
 */

import type { eventWithTime } from 'rrweb';

const SDK_TAG = '[@bworlds/launchkit]';
const FLUSH_INTERVAL_MS = 10_000;
const MAX_CHUNK_BYTES = 512_000; // 512 KB per chunk

let _sessionId: string | null = null;
let _sequenceNumber = 0;
let _eventBuffer: eventWithTime[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _stopRecording: (() => void) | null = null;
let _capReached = false;
let _flushing = false;
let _buildSlug: string | null = null;
let _apiEndpoint: string | null = null;
let _visibilityHandler: (() => void) | null = null;
let _unloadHandler: (() => void) | null = null;
// Cached from dynamic import so _hasErrors can use it at flush time
let _EventType: { Custom: number } | null = null;

function _generateSessionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function _hasErrors(events: eventWithTime[]): boolean {
  if (!_EventType) return false;
  return events.some(
    (e) =>
      e.type === _EventType!.Custom &&
      (e.data as Record<string, unknown>)?.tag === 'error',
  );
}

async function _flushChunk(events: eventWithTime[]): Promise<void> {
  if (!_buildSlug || !_apiEndpoint || !_sessionId || events.length === 0)
    return;

  const payload = {
    buildSlug: _buildSlug,
    sessionId: _sessionId,
    sequenceNumber: _sequenceNumber,
    events,
    hasErrors: _hasErrors(events),
  };

  const body = JSON.stringify(payload);
  const bodyBytes = new TextEncoder().encode(body).byteLength;

  // Split oversized chunks recursively instead of dropping events
  if (bodyBytes > MAX_CHUNK_BYTES && events.length > 1) {
    const mid = Math.floor(events.length / 2);
    await _flushChunk(events.slice(0, mid));
    await _flushChunk(events.slice(mid));
    return;
  }

  if (bodyBytes > MAX_CHUNK_BYTES) {
    // Single event exceeds limit, nothing we can do
    console.warn(
      `${SDK_TAG} Replay event too large (${(bodyBytes / 1024).toFixed(0)} KB, limit ${MAX_CHUNK_BYTES / 1024} KB). Event dropped.`,
    );
    return;
  }

  try {
    const resp = await fetch(
      `${_apiEndpoint}/api/telemetry/replay-events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      },
    );

    if (resp.status === 429) {
      _capReached = true;
      console.info(
        `${SDK_TAG} Session replay daily cap reached. Recording stopped.`,
      );
      stopReplay();
      return;
    }

    if (!resp.ok) {
      console.warn(
        `${SDK_TAG} Replay chunk upload failed (HTTP ${resp.status}).`,
      );
      return;
    }

    // Increment only after confirmed delivery
    _sequenceNumber += 1;
  } catch (err: unknown) {
    console.warn(
      `${SDK_TAG} Replay chunk upload failed (network error).`,
      err,
    );
  }
}

async function _flush(isFinal = false): Promise<void> {
  if (_capReached || _eventBuffer.length === 0 || _flushing) return;
  _flushing = true;
  try {
    const events = _eventBuffer.splice(0);
    await _flushChunk(events);
  } finally {
    _flushing = false;
  }
}

/** Synchronous flush via sendBeacon for page unload. */
function _beaconFlush(): void {
  if (_capReached || _eventBuffer.length === 0) return;
  if (!_buildSlug || !_apiEndpoint || !_sessionId) return;

  const events = _eventBuffer.splice(0);
  const payload = {
    buildSlug: _buildSlug,
    sessionId: _sessionId,
    sequenceNumber: _sequenceNumber,
    events,
    hasErrors: _hasErrors(events),
  };

  const body = JSON.stringify(payload);
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(
      `${_apiEndpoint}/api/telemetry/replay-events`,
      new Blob([body], { type: 'application/json' }),
    );
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
}

export async function startReplay(
  buildSlug: string,
  apiEndpoint: string,
): Promise<void> {
  if (_stopRecording) return; // Already recording
  _buildSlug = buildSlug;
  _apiEndpoint = apiEndpoint.replace(/\/+$/, ''); // Strip trailing slashes
  _sessionId = _generateSessionId();
  _sequenceNumber = 0;
  _eventBuffer = [];
  _capReached = false;

  // Dynamic import — rrweb is only loaded when replay is enabled
  let rrweb: typeof import('rrweb') | null = null;
  try {
    rrweb = await import('rrweb');
  } catch (err: unknown) {
    const isModuleNotFound =
      err instanceof Error &&
      (err.message.includes('Cannot find module') ||
        err.message.includes('Failed to resolve module') ||
        err.message.includes('Module not found'));
    if (!isModuleNotFound) {
      console.warn(
        `${SDK_TAG} Session replay failed to initialize. rrweb threw:`,
        err,
      );
    }
    return;
  }

  const { record, EventType } = rrweb;
  _EventType = EventType;

  const stop = record({
    emit(event: eventWithTime) {
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
