import { gunzipSync, strFromU8 } from 'fflate';
import { startReplay, stopReplay } from '../src/replay';
import { enqueueError, startErrorCapture, stopErrorCapture } from '../src/error-capture';
import { sendTelemetry } from '../src/telemetry-sender';
import { getVisitorId } from '../src/visitor-state';

vi.mock('../src/telemetry-sender', () => ({
  sendTelemetry: vi.fn(),
}));

vi.mock('../src/visitor-state', () => ({
  getVisitorId: vi.fn(() => 'visitor-fixed-id'),
}));

const mockSendTelemetry = vi.mocked(sendTelemetry);

// ---------------------------------------------------------------------------
// rrweb mock — hoisted so the dynamic import() inside replay.ts resolves to it.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  let capturedEmit: ((event: unknown) => void) | null = null;
  const getEmit = () => capturedEmit;
  const setEmit = (e: ((event: unknown) => void) | null) => {
    capturedEmit = e;
  };
  return {
    getEmit,
    setEmit,
    stopRecording: vi.fn(),
    takeFullSnapshot: vi.fn(),
    addCustomEvent: vi.fn(),
    recordFactory: vi.fn(),
    // When true, record() returns no stop handle (rrweb init failure path).
    recordReturnsNoHandle: { value: false },
  };
});

vi.mock('rrweb', () => {
  const record = Object.assign(
    (opts: { emit: (event: unknown) => void }) => {
      hoisted.setEmit(opts.emit);
      hoisted.recordFactory(opts);
      return hoisted.recordReturnsNoHandle.value ? undefined : hoisted.stopRecording;
    },
    {
      takeFullSnapshot: hoisted.takeFullSnapshot,
      addCustomEvent: hoisted.addCustomEvent,
    },
  );
  return {
    record,
    EventType: { Custom: 5, FullSnapshot: 2, IncrementalSnapshot: 3 },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const STORAGE_KEY = 'bworlds-replay-session';
const BOOTSTRAP_STORAGE_KEY = 'bworlds-replay-bootstrap-chunk';
const BUILD_SLUG = 'test-build';
const API_ENDPOINT = 'https://api.test';
const START_NOW = 1_000_000;

interface StoredSession {
  id: string;
  seq: number;
  startedAt: number;
  lastActivityAt: number;
  firstChunkAcked?: boolean;
}

const fetchMock = vi.fn();

/** Resolve pending microtasks (fetch promises inside _flushChunk). */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Captures replay's interval callbacks so fetch-retry tests can fire the
 * periodic flush tick deterministically — the page-hidden path delivers
 * through sendBeacon, so it cannot stand in for the fetch tick.
 */
let capturedIntervals: Array<{ fn: () => void; ms: number }> = [];

function stubIntervalCapture(): void {
  capturedIntervals = [];
  let nextHandle = 1;
  vi.stubGlobal('setInterval', ((fn: () => void, ms: number) => {
    capturedIntervals.push({ fn, ms });
    return nextHandle++;
  }) as unknown as typeof setInterval);
  vi.stubGlobal('clearInterval', (() => {}) as unknown as typeof clearInterval);
}

/** Fire the 10s flush tick captured by stubIntervalCapture. */
function flushTick(): void {
  capturedIntervals.find((entry) => entry.ms === 10_000)?.fn();
}

/** Fire the 5-minute periodic FullSnapshot tick captured by stubIntervalCapture. */
function snapshotTick(): void {
  capturedIntervals.find((entry) => entry.ms === 300_000)?.fn();
}

function parseFetchBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as { body?: string };
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
}

async function parseBeaconBody(call: unknown[]): Promise<Record<string, unknown>> {
  const blob = call[1] as Blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = isGzip ? strFromU8(gunzipSync(bytes)) : await blob.text();
  return JSON.parse(text) as Record<string, unknown>;
}

/** Deterministic pseudo-random text that gzip cannot meaningfully shrink. */
function incompressibleText(length: number): string {
  let seed = 0x2f6e2b1;
  let out = '';
  while (out.length < length) {
    seed = (seed * 48271) % 0x7fffffff;
    out += seed.toString(36);
  }
  return out.slice(0, length);
}

function readStoredSession(): StoredSession {
  return JSON.parse(sessionStorage.getItem(STORAGE_KEY)!) as StoredSession;
}

function readStoredBootstrap(): {
  buildSlug: string;
  apiEndpoint: string;
  sessionId: string;
  sequenceNumber: 0;
  events: unknown[];
} {
  return JSON.parse(sessionStorage.getItem(BOOTSTRAP_STORAGE_KEY)!) as {
    buildSlug: string;
    apiEndpoint: string;
    sessionId: string;
    sequenceNumber: 0;
    events: unknown[];
  };
}

function okResponse() {
  return { ok: true, status: 200 } as Response;
}

/** Build an unsigned JWT (header.payload.sig) the SDK can decode without verifying. */
function makeToken(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0].trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
}

function appendViteClientScript() {
  const script = document.createElement('script');
  script.type = 'module';
  script.src = '/@vite/client';
  document.head.appendChild(script);
  return script;
}

function appendViteDevCss() {
  const style = document.createElement('style');
  style.setAttribute('data-vite-dev-id', '/src/index.css');
  style.textContent = 'body { color: rgb(10, 20, 30); }';
  document.head.appendChild(style);
  return style;
}

function fullSnapshotEvent(hasViteDevCss: boolean, marker: string) {
  const headChildren = hasViteDevCss
    ? [
        {
          type: 2,
          id: 4,
          tagName: 'style',
          attributes: { 'data-vite-dev-id': '/src/index.css' },
          childNodes: [{ type: 3, id: 5, textContent: 'body{}' }],
        },
      ]
    : [];

  return {
    type: 2,
    timestamp: Date.now(),
    data: {
      marker,
      initialOffset: { top: 0, left: 0 },
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'html',
            attributes: {},
            childNodes: [
              {
                type: 2,
                id: 3,
                tagName: 'head',
                attributes: {},
                childNodes: headChildren,
              },
              {
                type: 2,
                id: 6,
                tagName: 'body',
                attributes: {},
                childNodes: [],
              },
            ],
          },
        ],
      },
    },
  };
}

function setNow(ms: number) {
  vi.setSystemTime(ms);
}

/** Errors of the most recent sendTelemetry batch (error-capture flush). */
function lastFlushedErrors(): Array<{ sessionId: string | null; capturedAt: number }> {
  const calls = mockSendTelemetry.mock.calls;
  const payload = calls[calls.length - 1][1] as {
    errors: Array<{ sessionId: string | null; capturedAt: number }>;
  };
  return payload.errors;
}

function allReplayDiagnostics(): Array<Record<string, unknown> & { sessionId: string }> {
  return mockSendTelemetry.mock.calls
    .filter(([path]) => path === '/api/telemetry/replay-diagnostics')
    .flatMap(([, payload]) => {
      const body = payload as {
        diagnostics: Array<Record<string, unknown> & { sessionId: string }>;
      };
      return body.diagnostics;
    });
}

function replayDiagnostics(): Array<{
  source: string;
  sessionId: string;
  metadata: Record<string, unknown>;
}> {
  return mockSendTelemetry.mock.calls
    .filter(([path]) => path === '/api/telemetry/replay-diagnostics')
    .flatMap(([, payload]) => {
      const body = payload as {
        diagnostics: Array<Record<string, unknown> & { sessionId: string }>;
      };
      return body.diagnostics
        .filter((diagnostic) => String(diagnostic.type).endsWith('_failed'))
        .map((diagnostic) => ({
          source: 'sdk-replay',
          sessionId: diagnostic.sessionId,
          metadata: {
            diagnostic: 'replay_chunk',
            isBootstrap: diagnostic.sequenceNumber === 0,
            ...diagnostic,
          },
        }));
    });
}

let visibilityState: DocumentVisibilityState = 'visible';
let originalVisibilityDescriptor: PropertyDescriptor | undefined;
let originalSendBeaconDescriptor: PropertyDescriptor | undefined;
let originalBlobStreamDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(START_NOW);
  mockSendTelemetry.mockClear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  clearCookies();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
  hoisted.setEmit(null);
  hoisted.stopRecording.mockClear();
  hoisted.takeFullSnapshot.mockReset();
  hoisted.takeFullSnapshot.mockImplementation(() => {
    hoisted.getEmit()?.({ type: 2, timestamp: Date.now(), data: {} });
  });
  hoisted.addCustomEvent.mockReset();
  hoisted.recordFactory.mockClear();
  hoisted.recordReturnsNoHandle.value = false;
  sessionStorage.clear();
  visibilityState = 'visible';
  originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
    Document.prototype,
    'visibilityState',
  );
  originalSendBeaconDescriptor =
    Object.getOwnPropertyDescriptor(Navigator.prototype, 'sendBeacon') ??
    Object.getOwnPropertyDescriptor(navigator, 'sendBeacon');
  originalBlobStreamDescriptor = Object.getOwnPropertyDescriptor(
    Blob.prototype,
    'stream',
  );
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  stopErrorCapture();
  stopReplay();
  vi.unstubAllGlobals();
  if (originalVisibilityDescriptor) {
    Object.defineProperty(
      Document.prototype,
      'visibilityState',
      originalVisibilityDescriptor,
    );
  }
  if (originalSendBeaconDescriptor) {
    Object.defineProperty(
      navigator,
      'sendBeacon',
      originalSendBeaconDescriptor,
    );
  } else {
    Reflect.deleteProperty(navigator, 'sendBeacon');
  }
  if (originalBlobStreamDescriptor) {
    Object.defineProperty(
      Blob.prototype,
      'stream',
      originalBlobStreamDescriptor,
    );
  } else {
    Reflect.deleteProperty(Blob.prototype, 'stream');
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('record options', () => {
  it('removes replay-irrelevant head and script noise from snapshots', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);

    expect(hoisted.recordFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        slimDOMOptions: {
          script: true,
          comment: true,
          headFavicon: true,
          headWhitespace: true,
          headMetaSocial: true,
          headMetaRobots: true,
          headMetaHttpEquiv: true,
          headMetaVerification: true,
        },
      }),
    );
  });

  it('emits positive replay lifecycle diagnostics and upload metadata', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    const sessionId = readStoredSession().id;

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(allReplayDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'session_started', sessionId, sdkVersion: expect.any(String) }),
        expect.objectContaining({ type: 'recorder_started', sessionId, sdkVersion: expect.any(String) }),
        expect.objectContaining({
          type: 'bootstrap_reserved',
          sessionId,
          sequenceNumber: 0,
          eventCount: 1,
          hasFullSnapshot: true,
        }),
        expect.objectContaining({
          type: 'bootstrap_upload_attempt',
          sessionId,
          sequenceNumber: 0,
          transport: 'fetch',
          rawBytes: expect.any(Number),
          compressedBytes: null,
          eventCount: 1,
          hasFullSnapshot: true,
        }),
        expect.objectContaining({
          type: 'bootstrap_upload_ok',
          sessionId,
          sequenceNumber: 0,
          transport: 'fetch',
          rawBytes: expect.any(Number),
        }),
      ]),
    );

    const payload = parseFetchBody(fetchMock.mock.calls[0]);
    expect(payload).toEqual(
      expect.objectContaining({
        sdkVersion: expect.any(String),
        transport: 'fetch',
        isFirstChunk: true,
        hasFullSnapshot: true,
        rawBytes: expect.any(Number),
        eventCount: 1,
        sequenceNumber: 0,
      }),
    );
    expect(payload).not.toHaveProperty('compressedBytes');
  });
});

describe('Vite dev CSS readiness', () => {
  it('waits for Vite dev CSS before starting rrweb', async () => {
    appendViteClientScript();

    const start = startReplay(BUILD_SLUG, API_ENDPOINT);
    await flushMicrotasks();

    expect(hoisted.recordFactory).not.toHaveBeenCalled();

    appendViteDevCss();
    await start;

    expect(hoisted.recordFactory).toHaveBeenCalledTimes(1);
  });

  it('drops a style-less Vite dev FullSnapshot after a styled snapshot and retries', async () => {
    visibilityState = 'hidden';
    appendViteClientScript();
    appendViteDevCss();

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    expect(emit).not.toBeNull();

    hoisted.takeFullSnapshot.mockImplementation(() => {
      emit!(fullSnapshotEvent(true, 'retry-styled'));
    });

    emit!(fullSnapshotEvent(true, 'initial-styled'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    emit!(fullSnapshotEvent(false, 'styleless-checkout'));

    await vi.waitFor(() => {
      expect(hoisted.takeFullSnapshot).toHaveBeenCalledWith(true);
    });

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const initialBody = parseFetchBody(fetchMock.mock.calls[0]);
    const retryBody = parseFetchBody(fetchMock.mock.calls[1]);
    expect(
      (initialBody.events as Array<{ data?: { marker?: string } }>).map(
        (event) => event.data?.marker,
      ),
    ).toEqual(['initial-styled']);
    expect(
      (retryBody.events as Array<{ data?: { marker?: string } }>).map(
        (event) => event.data?.marker,
      ),
    ).toEqual(['retry-styled']);
  });
});

describe('session rotation', () => {
  it('rotates to a new session id when emit fires after the idle threshold', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    expect(emit).not.toBeNull();

    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    const firstSessionId = readStoredSession().id;

    setNow(START_NOW + IDLE_TIMEOUT_MS + 1_000);
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });

    const secondSessionId = readStoredSession().id;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(hoisted.takeFullSnapshot).toHaveBeenCalledWith(true);
  });

  it('flushes the old buffer under the old session identity', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: {} });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    const oldSessionId = readStoredSession().id;

    setNow(START_NOW + IDLE_TIMEOUT_MS + 1_000);
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = parseFetchBody(fetchMock.mock.calls[1]);
    expect(body.sessionId).toBe(oldSessionId);
    expect(body.sequenceNumber).toBe(1);
    expect((body.events as unknown[]).length).toBe(1);
  });

  it('starts the new session at sequenceNumber 0 and emits subsequent chunks under it', async () => {
    visibilityState = 'hidden';

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });

    setNow(START_NOW + IDLE_TIMEOUT_MS + 1_000);
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    await flushMicrotasks();

    const newSessionId = readStoredSession().id;
    await vi.waitFor(() => expect(readStoredSession().seq).toBe(1));

    const latestBody = parseFetchBody(
      fetchMock.mock.calls[fetchMock.mock.calls.length - 1],
    );
    expect(latestBody.sessionId).toBe(newSessionId);
    expect(latestBody.sequenceNumber).toBe(0);
  });

  it('does not let failed chunks from a rotated session block the active session', async () => {
    visibilityState = 'hidden';
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'old-bootstrap' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushMicrotasks();
    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'old-tail' } });

    hoisted.takeFullSnapshot.mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValue(okResponse());

    setNow(START_NOW + IDLE_TIMEOUT_MS + 1_000);
    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'new-before-snapshot' } });
    await flushMicrotasks();

    const newSessionId = readStoredSession().id;
    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'new-bootstrap' } });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const latestBody = parseFetchBody(fetchMock.mock.calls[2]);
    expect(latestBody.sessionId).toBe(newSessionId);
    expect(latestBody.sequenceNumber).toBe(0);
    expect(latestBody.events).toMatchObject([
      { type: 2, data: { marker: 'new-bootstrap' } },
    ]);
  });

  it('does not rotate when emit fires under the idle threshold', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    const firstSessionId = readStoredSession().id;

    setNow(START_NOW + IDLE_TIMEOUT_MS - 1);
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    await flushMicrotasks();

    expect(readStoredSession().id).toBe(firstSessionId);
    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not rotate on the very first event of a fresh session', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    // Even if "now" has jumped relative to the session start, the first emit
    // has no prior _lastEventAt so rotation logic is skipped.
    setNow(START_NOW + IDLE_TIMEOUT_MS * 10);
    emit!({ type: 2, timestamp: Date.now(), data: {} });

    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();
  });

  it('does not advance the new session seq when a flush races a rotation', async () => {
    visibilityState = 'hidden';

    // Fetch resolves only when we release it, simulating an in-flight flush.
    let releaseFetch!: (value: Response) => void;
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    // First chunk queued under session A.
    emit!({ type: 2, timestamp: Date.now(), data: {} });
    const sessionA = readStoredSession().id;

    // Trigger a visibility flush; fetch is pending.
    const visibilityFlush = new Promise<void>((resolve) => {
      document.addEventListener('visibilitychange', () => resolve(), {
        once: true,
      });
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await visibilityFlush;

    // Rotate while the flush is still in-flight.
    setNow(START_NOW + IDLE_TIMEOUT_MS + 1_000);
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    const sessionB = readStoredSession().id;
    expect(sessionB).not.toBe(sessionA);
    expect(readStoredSession().seq).toBe(0);

    // Release the pending session-A flush — it must not bump session B's seq.
    fetchMock.mockResolvedValue(okResponse());
    releaseFetch(okResponse());
    await flushMicrotasks();
    await flushMicrotasks();

    expect(readStoredSession().id).toBe(sessionB);
    expect(readStoredSession().seq).toBe(0);
  });
});

describe('error–session stamping', () => {
  it('test_req_error_session_stamp: error captured while replay is recording carries the active session id and capture timestamp', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const activeSessionId = readStoredSession().id;

    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'boom during recording',
      stack: null,
      url: 'https://example.com',
      source: 'uncaught',
    });
    stopErrorCapture(); // flushes the queue synchronously

    const [error] = lastFlushedErrors();
    expect(error.sessionId).toBe(activeSessionId);
    expect(error.capturedAt).toBe(START_NOW);
  });

  it('test_req_rotation_stamp: error captured after a rotation carries the new session id', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    const oldSessionId = readStoredSession().id;

    setNow(START_NOW + IDLE_TIMEOUT_MS + 1_000);
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } }); // triggers rotation
    const newSessionId = readStoredSession().id;
    expect(newSessionId).not.toBe(oldSessionId);

    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'after rotation',
      stack: null,
      url: null,
      source: 'console',
    });
    stopErrorCapture();

    const [error] = lastFlushedErrors();
    expect(error.sessionId).toBe(newSessionId);
  });

  it('resume_stamp: error captured after a stop/restart resume carries the resumed session id', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const firstSessionId = readStoredSession().id;
    stopReplay();

    // Restart WITHOUT clearing sessionStorage — _resolveSession resumes the
    // stored session (idle < 4 min, age < 60 min) and republishes its id.
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    expect(readStoredSession().id).toBe(firstSessionId);

    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'after resume',
      stack: null,
      url: null,
      source: 'console',
    });
    stopErrorCapture();

    const [error] = lastFlushedErrors();
    expect(error.sessionId).toBe(firstSessionId);
  });

  it('test_req_no_replay_null_session: error captured after replay stops carries a null session id', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    stopReplay();

    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'no replay running',
      stack: null,
      url: null,
      source: 'network',
    });
    stopErrorCapture();

    const [error] = lastFlushedErrors();
    expect(error.sessionId).toBeNull();
    expect(typeof error.capturedAt).toBe('number');
  });

  it('daily_cap_429_clears_session: error captured after the 429 daily-cap stop carries a null session id', async () => {
    visibilityState = 'hidden';
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    // Chunk upload hits the daily cap; replay stops itself via stopReplay().
    fetchMock.mockResolvedValue({ ok: false, status: 429 } as Response);
    emit!({ type: 2, timestamp: Date.now(), data: {} });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();
    expect(hoisted.stopRecording).toHaveBeenCalled();

    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'after daily cap',
      stack: null,
      url: null,
      source: 'uncaught',
    });
    stopErrorCapture();

    const [error] = lastFlushedErrors();
    // Footage ended at the cap — the error must not point at that session.
    expect(error.sessionId).toBeNull();
    infoSpy.mockRestore();
  });
});

describe('pre-replay error back-stamp', () => {
  it('backstamp_queued_errors: error queued before replay starts is stamped with the session once recording begins', async () => {
    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'fired during replay module import',
      stack: null,
      url: null,
      source: 'uncaught',
    });

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const activeSessionId = readStoredSession().id;

    stopErrorCapture(); // flushes the queue synchronously

    const [error] = lastFlushedErrors();
    expect(error.sessionId).toBe(activeSessionId);
    // Back-stamping rewrites the session link only — capture time is preserved.
    expect(error.capturedAt).toBe(START_NOW);
  });

  it('backstamp_only_null_sessions: errors stamped at capture time keep their original session', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const firstSessionId = readStoredSession().id;

    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'live-stamped under first session',
      stack: null,
      url: null,
      source: 'console',
    });

    // Restart replay under a fresh session while the error is still queued.
    stopReplay();
    sessionStorage.clear();
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const secondSessionId = readStoredSession().id;
    expect(secondSessionId).not.toBe(firstSessionId);

    stopErrorCapture();

    const [error] = lastFlushedErrors();
    expect(error.sessionId).toBe(firstSessionId);
  });

  it('failed_start_clears_session: record() returning no stop handle clears the shared session id', async () => {
    hoisted.recordReturnsNoHandle.value = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await startReplay(BUILD_SLUG, API_ENDPOINT);

    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'after failed replay start',
      stack: null,
      url: null,
      source: 'network',
    });
    stopErrorCapture();

    const [error] = lastFlushedErrors();
    // No recording exists — the error must not point at a dead session.
    expect(error.sessionId).toBeNull();
    warnSpy.mockRestore();
  });
});

describe('sequence reservation', () => {
  it('does not start two rrweb recorders when startReplay is called concurrently', async () => {
    await Promise.all([
      startReplay(BUILD_SLUG, API_ENDPOINT),
      startReplay(BUILD_SLUG, API_ENDPOINT),
    ]);

    expect(hoisted.recordFactory).toHaveBeenCalledTimes(1);
  });

  it('keeps sequence numbers monotone when a flush tick fires during the initial flush', async () => {
    stubIntervalCapture();

    let releaseFetch!: (value: Response) => void;
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });

    expect(parseFetchBody(fetchMock.mock.calls[0]).sequenceNumber).toBe(0);
    expect(readStoredSession().seq).toBe(1);

    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'during-fetch' } });
    flushTick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFetch(okResponse());
    await flushMicrotasks();
    flushTick();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(parseFetchBody(fetchMock.mock.calls[1]).sequenceNumber).toBe(1);
  });

  it('uses the next sequenceNumber for pagehide sendBeacon during the initial fetch', async () => {
    visibilityState = 'hidden';

    let releaseFetch!: (value: Response) => void;
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );
    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));

    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    document.dispatchEvent(new Event('visibilitychange'));
    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'unload' } });

    window.dispatchEvent(new Event('pagehide'));

    expect(parseFetchBody(fetchMock.mock.calls[0]).sequenceNumber).toBe(0);
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(
      (await parseBeaconBody(sendBeaconMock.mock.calls[0])).sequenceNumber,
    ).toBe(1);

    releaseFetch(okResponse());
    await flushMicrotasks();
  });

  it('retries a failed chunk with the same sequenceNumber and payload', async () => {
    stubIntervalCapture();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValue(okResponse());

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    const stored = readStoredSession();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await flushMicrotasks();

    const failedBody = parseFetchBody(fetchMock.mock.calls[0]);
    expect(failedBody.sequenceNumber).toBe(0);

    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'after-failure' } });
    // The first chunk's retry is held in exponential backoff; advance past it.
    setNow(START_NOW + 60_000);
    flushTick();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const retryBody = parseFetchBody(fetchMock.mock.calls[1]);
    expect(retryBody.sequenceNumber).toBe(0);
    expect(retryBody.events).toEqual(failedBody.events);
    expect(readStoredSession().id).toBe(stored.id);
    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();

    await flushMicrotasks();
    flushTick();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(parseFetchBody(fetchMock.mock.calls[2]).sequenceNumber).toBe(1);
  });

  it('delivers the pending first chunk through the beacon during backoff', async () => {
    visibilityState = 'hidden';
    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValue(okResponse());

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await flushMicrotasks();

    // The rejected bootstrap sits in exponential backoff for the fetch path;
    // the page-hidden beacon flush delivers it anyway — backoff protects the
    // API from hammering, not the residual from a dying page.
    document.dispatchEvent(new Event('visibilitychange'));

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(
      (await parseBeaconBody(sendBeaconMock.mock.calls[0])).sequenceNumber,
    ).toBe(0);
  });

  it('rate-limits retry diagnostics for later chunks', async () => {
    stubIntervalCapture();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValue(okResponse());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    const sessionId = readStoredSession().id;

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushMicrotasks();
    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'later' } });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      flushTick();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(attempt + 1));
      await flushMicrotasks();
    }

    expect(replayDiagnostics()).toMatchObject([
      {
        sessionId,
        metadata: {
          diagnostic: 'replay_chunk',
          sessionId,
          sequenceNumber: 1,
          isBootstrap: false,
          attempt: 1,
          reason: 'http_retry',
          httpStatus: 503,
          rawBytes: expect.any(Number),
          compressedBytes: null,
          transport: 'fetch',
          hasFullSnapshot: false,
          sdkVersion: expect.any(String),
        },
      },
      {
        sessionId,
        metadata: { sequenceNumber: 1, isBootstrap: false, attempt: 3 },
      },
      {
        sessionId,
        metadata: { sequenceNumber: 1, isBootstrap: false, attempt: 5 },
      },
    ]);

    flushTick();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));

    warnSpy.mockRestore();
  });

  it('continues the session when the first chunk is dropped', async () => {
    stubIntervalCapture();
    vi.stubGlobal('CompressionStream', undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    const sessionId = readStoredSession().id;

    emit!({
      type: 2,
      timestamp: Date.now(),
      data: { html: 'x'.repeat(520_000) },
    });
    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();
    expect(readStoredSession().id).toBe(sessionId);
    expect(readStoredSession().seq).toBe(1);
    expect(replayDiagnostics()).toMatchObject([
      {
        sessionId,
        metadata: {
          diagnostic: 'replay_chunk',
          sessionId,
          sequenceNumber: 0,
          attempt: 1,
          reason: 'body_too_large',
          rawBytes: expect.any(Number),
          compressedBytes: null,
          transport: 'fetch',
          hasFullSnapshot: true,
          sdkVersion: expect.any(String),
        },
      },
    ]);

    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'telemetry-only' } });
    flushTick();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = parseFetchBody(fetchMock.mock.calls[0]);
    expect(body.sessionId).toBe(sessionId);
    expect(body.sequenceNumber).toBe(1);
    expect(body.events).toMatchObject([
      { type: 3, data: { marker: 'telemetry-only' } },
    ]);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('keeps small replay chunks on the raw JSON upload path', async () => {
    visibilityState = 'hidden';
    const CompressionStreamMock = vi.fn();
    vi.stubGlobal(
      'CompressionStream',
      CompressionStreamMock as unknown as typeof CompressionStream,
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };

    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(typeof init.body).toBe('string');
    expect(CompressionStreamMock).not.toHaveBeenCalled();
  });

  it('drops unusable incremental events before the initial FullSnapshot', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 3, timestamp: Date.now(), data: { source: 0 } });
    emit!({ type: 4, timestamp: Date.now(), data: { href: 'https://app.test' } });
    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = parseFetchBody(fetchMock.mock.calls[0]);
    expect(body.sequenceNumber).toBe(0);
    expect(body.events).toMatchObject([
      { type: 4 },
      { type: 2, data: { marker: 'initial' } },
    ]);
  });

  it('uploads a compressed oversized first chunk when gzip fits the transport budget', async () => {
    visibilityState = 'hidden';
    const pipeThrough = vi.fn(() => 'compressed-stream');
    Object.defineProperty(Blob.prototype, 'stream', {
      configurable: true,
      value: vi.fn(() => ({ pipeThrough })),
    });
    vi.stubGlobal(
      'CompressionStream',
      class FakeCompressionStream {} as unknown as typeof CompressionStream,
    );
    vi.stubGlobal(
      'Response',
      class FakeResponse {
        constructor(readonly body: unknown) {}
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3]).buffer;
        }
      } as unknown as typeof Response,
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    const sessionId = readStoredSession().id;

    emit!({
      type: 2,
      timestamp: Date.now(),
      data: { html: 'x'.repeat(520_000) },
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0][1] as {
      body: ArrayBuffer;
      headers: Record<string, string>;
    };

    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    });
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect(init.body.byteLength).toBeLessThan(512_000);
    expect(readStoredSession().id).toBe(sessionId);
    expect(readStoredSession().firstChunkAcked).toBe(true);
    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();
  });

  it('keeps the initial Meta and oversized FullSnapshot in the same gzip chunk', async () => {
    visibilityState = 'hidden';
    const pipeThrough = vi.fn(() => 'compressed-stream');
    Object.defineProperty(Blob.prototype, 'stream', {
      configurable: true,
      value: vi.fn(() => ({ pipeThrough })),
    });
    vi.stubGlobal(
      'CompressionStream',
      class FakeCompressionStream {} as unknown as typeof CompressionStream,
    );
    vi.stubGlobal(
      'Response',
      class FakeResponse {
        constructor(readonly body: unknown) {}
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3]).buffer;
        }
      } as unknown as typeof Response,
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 4, timestamp: Date.now(), data: { href: 'https://app.test' } });
    emit!({
      type: 2,
      timestamp: Date.now(),
      data: { html: 'x'.repeat(520_000) },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0][1] as {
      body: ArrayBuffer;
      headers: Record<string, string>;
    };

    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    });
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect(readStoredSession().seq).toBe(1);
    expect(readStoredSession().firstChunkAcked).toBe(true);
  });

  it('persists the bootstrap chunk until sequenceNumber 0 is acknowledged', async () => {
    visibilityState = 'hidden';
    let releaseFetch!: (value: Response) => void;
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    const sessionId = readStoredSession().id;

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const storedBootstrap = readStoredBootstrap();
    expect(storedBootstrap.buildSlug).toBe(BUILD_SLUG);
    expect(storedBootstrap.apiEndpoint).toBe(API_ENDPOINT);
    expect(storedBootstrap.sessionId).toBe(sessionId);
    expect(storedBootstrap.sequenceNumber).toBe(0);
    expect(storedBootstrap.events).toMatchObject([
      { type: 2, data: { marker: 'initial' } },
    ]);

    releaseFetch(okResponse());
    await flushMicrotasks();
    expect(sessionStorage.getItem(BOOTSTRAP_STORAGE_KEY)).toBeNull();
  });

  it('resends a stored bootstrap chunk after reload before recording new chunks', async () => {
    visibilityState = 'hidden';
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: 'persisted-session',
        seq: 1,
        startedAt: START_NOW - 1_000,
        lastActivityAt: START_NOW - 500,
        firstChunkAcked: false,
      }),
    );
    sessionStorage.setItem(
      BOOTSTRAP_STORAGE_KEY,
      JSON.stringify({
        buildSlug: BUILD_SLUG,
        apiEndpoint: API_ENDPOINT,
        sessionId: 'persisted-session',
        sequenceNumber: 0,
        createdAt: START_NOW - 500,
        events: [{ type: 2, timestamp: START_NOW - 500, data: { marker: 'persisted' } }],
      }),
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = parseFetchBody(fetchMock.mock.calls[0]);
    expect(body.sessionId).toBe('persisted-session');
    expect(body.sequenceNumber).toBe(0);
    expect(body.events).toMatchObject([
      { type: 2, data: { marker: 'persisted' } },
    ]);
    expect(readStoredSession().id).toBe('persisted-session');
    expect(readStoredSession().seq).toBe(1);
    expect(readStoredSession().firstChunkAcked).toBe(true);
    expect(sessionStorage.getItem(BOOTSTRAP_STORAGE_KEY)).toBeNull();
  });

  it('keeps sequence numbers monotone when stored session seq is stale', async () => {
    stubIntervalCapture();
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: 'persisted-session',
        seq: 0,
        startedAt: START_NOW - 1_000,
        lastActivityAt: START_NOW - 500,
        firstChunkAcked: false,
      }),
    );
    sessionStorage.setItem(
      BOOTSTRAP_STORAGE_KEY,
      JSON.stringify({
        buildSlug: BUILD_SLUG,
        apiEndpoint: API_ENDPOINT,
        sessionId: 'persisted-session',
        sequenceNumber: 0,
        createdAt: START_NOW - 500,
        events: [{ type: 2, timestamp: START_NOW - 500, data: { marker: 'persisted' } }],
      }),
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushMicrotasks();
    const emit = hoisted.getEmit();

    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'after-restore' } });
    flushTick();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(parseFetchBody(fetchMock.mock.calls[1]).sequenceNumber).toBe(1);
    expect(readStoredSession().seq).toBe(2);
  });

  it('ignores stored bootstrap chunks from another build context', async () => {
    visibilityState = 'hidden';
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: 'persisted-session',
        seq: 1,
        startedAt: START_NOW - 1_000,
        lastActivityAt: START_NOW - 500,
        firstChunkAcked: false,
      }),
    );
    sessionStorage.setItem(
      BOOTSTRAP_STORAGE_KEY,
      JSON.stringify({
        buildSlug: 'other-build',
        apiEndpoint: API_ENDPOINT,
        sessionId: 'persisted-session',
        sequenceNumber: 0,
        createdAt: START_NOW - 500,
        events: [{ type: 2, timestamp: START_NOW - 500, data: { marker: 'persisted' } }],
      }),
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readStoredSession().id).not.toBe('persisted-session');
    expect(sessionStorage.getItem(BOOTSTRAP_STORAGE_KEY)).toBeNull();
  });

  it('ignores stored bootstrap chunks without a FullSnapshot', async () => {
    visibilityState = 'hidden';
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: 'persisted-session',
        seq: 1,
        startedAt: START_NOW - 1_000,
        lastActivityAt: START_NOW - 500,
        firstChunkAcked: false,
      }),
    );
    sessionStorage.setItem(
      BOOTSTRAP_STORAGE_KEY,
      JSON.stringify({
        buildSlug: BUILD_SLUG,
        apiEndpoint: API_ENDPOINT,
        sessionId: 'persisted-session',
        sequenceNumber: 0,
        createdAt: START_NOW - 500,
        events: [{ type: 4, timestamp: START_NOW - 500, data: { href: 'https://app.test' } }],
      }),
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readStoredSession().id).not.toBe('persisted-session');
    expect(sessionStorage.getItem(BOOTSTRAP_STORAGE_KEY)).toBeNull();
  });

  it('uses raw JSON when gzip would make the chunk larger', async () => {
    visibilityState = 'hidden';
    Object.defineProperty(Blob.prototype, 'stream', {
      configurable: true,
      value: vi.fn(() => ({ pipeThrough: vi.fn(() => 'compressed-stream') })),
    });
    vi.stubGlobal(
      'CompressionStream',
      class FakeCompressionStream {} as unknown as typeof CompressionStream,
    );
    vi.stubGlobal(
      'Response',
      class FakeResponse {
        constructor(readonly body: unknown) {}
        async arrayBuffer() {
          return new Uint8Array(100_000).buffer;
        }
      } as unknown as typeof Response,
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({
      type: 2,
      timestamp: Date.now(),
      data: { html: 'x'.repeat(70_000) },
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };

    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(typeof init.body).toBe('string');
  });

  it('does not recover the session when sendBeacon drops a chunk on unload', async () => {
    const sendBeaconMock = vi.fn(() => false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    const sessionId = readStoredSession().id;

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushMicrotasks();
    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'before-unload' } });
    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Replay final upload was not queued by the browser'),
    );
    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();
    expect(readStoredSession().id).toBe(sessionId);

    // No retry-in-place: a terminal pagehide is the page's last event, so the
    // beacon-dropped chunk is not re-queued. A later flush finds nothing to send.
    visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('logs when sendBeacon cannot send an oversized chunk', async () => {
    const sendBeaconMock = vi.fn(() => true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const seqBefore = readStoredSession().seq;
    emit!({
      type: 3,
      timestamp: Date.now(),
      // Below FLUSH_SOFT_MAX_BYTES so the residual stays buffered until pagehide,
      // yet a single pseudo-random event gzip cannot bring under the beacon cap
      // and splitting cannot shrink: it is dropped without burning a sequence
      // number, and the loss report declares it.
      data: { html: incompressibleText(250_000) },
    });
    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeaconMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Replay final upload is too large for unload delivery'),
    );
    expect(readStoredSession().seq).toBe(seqBefore);
    expect(allReplayDiagnostics()).toContainEqual(
      expect.objectContaining({
        type: 'unload_chunks_dropped',
        reason: 'unload_budget_exhausted',
        eventCount: 1,
      }),
    );

    warnSpy.mockRestore();
  });

  it('continues uploading later chunks after the first chunk fails the maximum number of attempts', async () => {
    stubIntervalCapture();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValue(okResponse());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    const sessionId = readStoredSession().id;

    // Attempt 1 is the eager flush the FullSnapshot capture triggers itself.
    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Each rejected first chunk schedules exponential backoff; advance past it
    // before each retry. The fifth attempt exhausts the bootstrap retry budget.
    const retryTimes = [30_000, 70_000, 150_000, 310_000];
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      setNow(START_NOW + retryTimes[attempt - 2]);
      flushTick();
      await flushMicrotasks();
      expect(fetchMock).toHaveBeenCalledTimes(attempt);
    }
    expect(sessionStorage.getItem(BOOTSTRAP_STORAGE_KEY)).toBeNull();
    expect(replayDiagnostics()).toMatchObject([
      {
        sessionId,
        metadata: {
          sequenceNumber: 0,
          attempt: 1,
          reason: 'http_retry',
          httpStatus: 500,
          transport: 'fetch',
          hasFullSnapshot: true,
        },
      },
      {
        sessionId,
        metadata: { attempt: 2, reason: 'http_retry', httpStatus: 500 },
      },
      {
        sessionId,
        metadata: { attempt: 3, reason: 'http_retry', httpStatus: 500 },
      },
      {
        sessionId,
        metadata: { attempt: 4, reason: 'http_retry', httpStatus: 500 },
      },
      {
        sessionId,
        metadata: { attempt: 5, reason: 'http_retry', httpStatus: 500 },
      },
      {
        sessionId,
        metadata: {
          sequenceNumber: 0,
          attempt: 5,
          reason: 'retry_budget_exhausted',
          httpStatus: 500,
          rawBytes: expect.any(Number),
          compressedBytes: null,
          transport: 'fetch',
          hasFullSnapshot: true,
          sdkVersion: expect.any(String),
        },
      },
    ]);

    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'telemetry-only' } });
    flushTick();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    const body = parseFetchBody(fetchMock.mock.calls[5]);
    expect(body.sessionId).toBe(sessionId);
    expect(body.sequenceNumber).toBe(1);
    expect(body.events).toMatchObject([
      { type: 3, data: { marker: 'telemetry-only' } },
    ]);

    warnSpy.mockRestore();
  });

  it('assigns distinct sequenceNumbers to oversized split chunks', async () => {
    visibilityState = 'hidden';

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({
      type: 2,
      timestamp: Date.now(),
      data: { html: 'x'.repeat(310_000) },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushMicrotasks();
    emit!({
      type: 3,
      timestamp: Date.now(),
      data: { text: 'y'.repeat(310_000) },
    });

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(parseFetchBody(fetchMock.mock.calls[0]).sequenceNumber).toBe(0);
    expect(parseFetchBody(fetchMock.mock.calls[1]).sequenceNumber).toBe(1);
  });

  it('opens a fresh sequenceNumber 0 session when sessionStorage is idle-stale', async () => {
    visibilityState = 'hidden';
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: 'old-session',
        seq: 7,
        startedAt: START_NOW - 1_000,
        lastActivityAt: START_NOW - IDLE_TIMEOUT_MS - 1,
        firstChunkAcked: true,
      }),
    );

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const stored = readStoredSession();
    expect(stored.id).not.toBe('old-session');
    expect(stored.seq).toBe(0);

    hoisted.getEmit()!({ type: 2, timestamp: Date.now(), data: {} });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = parseFetchBody(fetchMock.mock.calls[0]);
    expect(body.sessionId).toBe(stored.id);
    expect(body.sequenceNumber).toBe(0);
  });
});

describe('unload transport', () => {
  async function startWithBootstrap() {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit()!;
    emit({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushMicrotasks();
    return emit;
  }

  it('flushes on capture via the compressed fetch path when the buffer passes the soft byte cap', async () => {
    const pipeThrough = vi.fn(() => 'compressed-stream');
    Object.defineProperty(Blob.prototype, 'stream', {
      configurable: true,
      value: vi.fn(() => ({ pipeThrough })),
    });
    vi.stubGlobal(
      'CompressionStream',
      class FakeCompressionStream {} as unknown as typeof CompressionStream,
    );
    vi.stubGlobal(
      'Response',
      class FakeResponse {
        constructor(readonly body: unknown) {}
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3]).buffer;
        }
      } as unknown as typeof Response,
    );

    const emit = await startWithBootstrap();

    // A heavy incremental event crosses FLUSH_SOFT_MAX_BYTES (256 KB); it must
    // leave on the compressed fetch path at capture, with no page-hidden event
    // and no timer, so it never accumulates into the unload residual.
    emit({ type: 3, timestamp: Date.now(), data: { html: 'x'.repeat(300_000) } });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe(`${API_ENDPOINT}/api/telemetry/replay-events`);
    const init = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    expect(init.headers['Content-Encoding']).toBe('gzip');
  });

  it('flushes on capture when a mid-session FullSnapshot is re-checked out', async () => {
    const emit = await startWithBootstrap();

    emit({ type: 3, timestamp: Date.now(), data: { source: 2, marker: 'incremental' } });
    // A re-checkout FullSnapshot mid-session (rrweb re-snapshots on tab return)
    // must flush immediately, not wait for the timer or land in the beacon.
    emit({ type: 2, timestamp: Date.now(), data: { marker: 're-checkout' } });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = parseFetchBody(fetchMock.mock.calls[1]);
    expect(body.sequenceNumber).toBe(1);
    expect(body.hasFullSnapshot).toBe(true);
  });

  it('gzips an unload residual above the beacon cap and delivers it as text/plain', async () => {
    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    const emit = await startWithBootstrap();

    // ~120 KB raw residual: past the ~64 KiB sendBeacon limit, but repetitive
    // markup compresses far below it, so pagehide delivers it gzipped with the
    // compression query param instead of dropping it.
    emit({ type: 3, timestamp: Date.now(), data: { html: 'x'.repeat(120_000) } });
    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeaconMock.mock.calls[0] as unknown as [string, Blob];
    expect(url).toContain('compression=gzip');
    expect(blob.type).toBe('text/plain');
    const body = JSON.parse(
      strFromU8(gunzipSync(new Uint8Array(await blob.arrayBuffer()))),
    ) as Record<string, unknown>;
    expect(body.sequenceNumber).toBe(1);
    expect(body.eventCount).toBe(1);
  });

  it('drops an unload residual still above the beacon cap after gzip', async () => {
    const sendBeaconMock = vi.fn(() => true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    const emit = await startWithBootstrap();

    // A single ~200 KB pseudo-random event gzip cannot bring under the ~64 KiB
    // cap and splitting cannot shrink: pagehide must drop it rather than hand
    // the browser a body it silently discards, and declare the loss.
    emit({ type: 3, timestamp: Date.now(), data: { html: incompressibleText(200_000) } });
    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeaconMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Replay final upload is too large for unload delivery'),
    );
    expect(allReplayDiagnostics()).toContainEqual(
      expect.objectContaining({
        type: 'unload_chunks_dropped',
        eventCount: 1,
      }),
    );
    warnSpy.mockRestore();
  });

  it('splits an oversized unload residual, delivers the earliest part, declares the rest', async () => {
    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    const emit = await startWithBootstrap();

    // Two DISTINCT pseudo-random events (identical ones would gzip-dedup into
    // one fitting body) whose combined body exceeds the per-call beacon cap.
    // The unload flush splits them, ships the earliest part — the footage
    // playback needs first — until the shared in-flight budget runs out, and
    // declares the remainder through the loss report instead of dropping the
    // whole residual silently.
    const noise = incompressibleText(160_000);
    emit({ type: 3, timestamp: Date.now(), data: { html: noise.slice(0, 80_000) } });
    emit({ type: 3, timestamp: Date.now(), data: { html: noise.slice(80_000) } });
    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const delivered = await parseBeaconBody(sendBeaconMock.mock.calls[0]);
    expect(delivered.sequenceNumber).toBe(1);
    expect(delivered.eventCount).toBe(1);
    expect(allReplayDiagnostics()).toContainEqual(
      expect.objectContaining({
        type: 'unload_chunks_dropped',
        reason: 'unload_budget_exhausted',
        eventCount: 1,
      }),
    );
  });

  it('delivers the buffered residual through the beacon when the page is hidden', async () => {
    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    const emit = await startWithBootstrap();
    fetchMock.mockClear();

    emit({ type: 3, timestamp: Date.now(), data: { marker: 'residual' } });
    visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));

    // hidden is the last event a dying page reliably fires: the residual must
    // leave synchronously via sendBeacon, never through an async fetch flush
    // that dies with the page.
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect((await parseBeaconBody(sendBeaconMock.mock.calls[0])).sequenceNumber).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes a periodic full snapshot while recording is active', async () => {
    stubIntervalCapture();
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    await flushMicrotasks();
    hoisted.takeFullSnapshot.mockClear();

    // Activity since the previous checkout: the tick re-snapshots so a lost
    // chunk can never strand more than one interval of footage.
    setNow(START_NOW + 60_000);
    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'activity' } });
    snapshotTick();
    expect(hoisted.takeFullSnapshot).toHaveBeenCalledTimes(1);
    expect(hoisted.takeFullSnapshot).toHaveBeenCalledWith(true);

    // Idle since the checkout above: an unchanged DOM earns no new snapshot.
    hoisted.takeFullSnapshot.mockClear();
    snapshotTick();
    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();

    // Hidden tab: skipped even with fresh activity.
    setNow(START_NOW + 120_000);
    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'more' } });
    visibilityState = 'hidden';
    snapshotTick();
    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();
  });

  it('beacons a residual within the beacon cap on a terminal pagehide', async () => {
    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    const emit = await startWithBootstrap();

    emit({ type: 3, timestamp: Date.now(), data: { source: 2, marker: 'residual' } });
    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    // Even a sub-cap residual ships gzipped: the browser's in-flight budget is
    // shared across the whole unload flush, so every body must stay small.
    expect((sendBeaconMock.mock.calls[0] as unknown as [string, Blob])[0]).toContain(
      'compression=gzip',
    );
    const body = await parseBeaconBody(sendBeaconMock.mock.calls[0]);
    expect(body.sequenceNumber).toBe(1);
  });

  it('delivers the residual on a persisted pagehide (bfcache freeze)', async () => {
    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    const emit = await startWithBootstrap();

    emit({ type: 3, timestamp: Date.now(), data: { source: 2, marker: 'residual' } });
    // A bfcache-frozen page can be evicted without ever firing a resume, so the
    // tail is beaconed now rather than kept buffered; sendBeacon does not block
    // the page from entering bfcache.
    const persistedPagehide = new Event('pagehide') as Event & { persisted?: boolean };
    Object.defineProperty(persistedPagehide, 'persisted', { value: true });
    window.dispatchEvent(persistedPagehide);

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const body = await parseBeaconBody(sendBeaconMock.mock.calls[0]);
    expect(body.sequenceNumber).toBe(1);
  });

  it('delivers a ~61 KB residual that fits the raised beacon cap', async () => {
    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeaconMock,
    });

    const emit = await startWithBootstrap();

    // ~61 KB: above the browser-conservative 60 KB the gate used before, still
    // under the 64 KB sendBeacon limit, so it must be delivered, not dropped.
    emit({ type: 3, timestamp: Date.now(), data: { html: 'x'.repeat(61_000) } });
    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
  });
});

describe('stopReplay cleanup', () => {
  it('invokes onStopped when recording stops', async () => {
    const onStopped = vi.fn();
    await startReplay(BUILD_SLUG, API_ENDPOINT, { onStopped });

    stopReplay();

    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it('invokes onStopped when the daily-cap 429 stops recording', async () => {
    const onStopped = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status: 429 } as Response);
    visibilityState = 'hidden';

    await startReplay(BUILD_SLUG, API_ENDPOINT, { onStopped });
    const emit = hoisted.getEmit();
    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });

    await vi.waitFor(() => expect(onStopped).toHaveBeenCalled());
  });

  it('clears the rrweb record reference and last-event timestamp', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    stopReplay();

    // After stop, a restart should not detect any leftover _lastEventAt and
    // therefore should not rotate on the first new emit.
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit2 = hoisted.getEmit();
    setNow(START_NOW + IDLE_TIMEOUT_MS * 5);
    emit2!({ type: 2, timestamp: Date.now(), data: {} });

    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();
  });
});


describe('link activation watcher', () => {
  async function settleLinkActivation(): Promise<void> {
    await Promise.resolve();
  }

  function lastLinkActivationCall() {
    const calls = hoisted.addCustomEvent.mock.calls;
    return calls[calls.length - 1] as [
      string,
      {
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
      },
    ];
  }

  function appendLink(attributes: Record<string, string>) {
    const link = document.createElement('a');
    for (const [name, value] of Object.entries(attributes)) {
      link.setAttribute(name, value);
    }
    link.textContent = 'Open';
    document.body.appendChild(link);
    return link;
  }

  function clickLink(link: Element, init: MouseEventInit = {}) {
    link.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init,
      }),
    );
  }

  it('emits a link_activation custom event for a navigable link click', async () => {
    history.replaceState({}, '', '/current');
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const link = appendLink({ href: '/checkout', target: '_blank', download: '' });

    setNow(START_NOW + 123);
    clickLink(link, { metaKey: true, shiftKey: true });
    await settleLinkActivation();

    expect(hoisted.addCustomEvent).toHaveBeenCalledTimes(1);
    expect(lastLinkActivationCall()).toEqual([
      'link_activation',
      {
        href: new URL('/checkout', location.href).href,
        currentHref: new URL('/current', location.href).href,
        target: '_blank',
        button: 0,
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        download: true,
        sameOrigin: true,
        sameDocument: false,
        sourceEventAtMs: START_NOW + 123,
      },
    ]);
  });

  it('captures link clicks even when the host stops propagation', async () => {
    history.replaceState({}, '', '/current');
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const link = appendLink({ href: '/after-stop-propagation' });
    link.addEventListener('click', (event) => event.stopPropagation());

    clickLink(link);
    await settleLinkActivation();

    expect(hoisted.addCustomEvent).toHaveBeenCalledTimes(1);
    expect(lastLinkActivationCall()[0]).toBe('link_activation');
  });

  it('records the href from click time before host handlers mutate the link', async () => {
    history.replaceState({}, '', '/current');
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const link = appendLink({ href: '/clicked' });
    link.addEventListener('click', () => {
      link.setAttribute('href', '/mutated');
    });

    clickLink(link);
    await settleLinkActivation();

    expect(lastLinkActivationCall()).toEqual([
      'link_activation',
      expect.objectContaining({ href: new URL('/clicked', location.href).href }),
    ]);
  });

  it('skips link clicks cancelled by the host app', async () => {
    history.replaceState({}, '', '/current');
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const link = appendLink({ href: '/cancelled' });
    link.addEventListener('click', (event) => event.preventDefault());

    clickLink(link);
    await settleLinkActivation();

    expect(hoisted.addCustomEvent).not.toHaveBeenCalled();
  });

  it('keeps modified clicks and new-tab targets as link activations', async () => {
    history.replaceState({}, '', '/current');
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const link = appendLink({ href: 'https://external.test/path', target: '_blank' });

    clickLink(link, { ctrlKey: true, altKey: true });
    await settleLinkActivation();

    expect(lastLinkActivationCall()).toEqual([
      'link_activation',
      expect.objectContaining({
        href: 'https://external.test/path',
        target: '_blank',
        ctrlKey: true,
        altKey: true,
        sameOrigin: false,
        sameDocument: false,
      }),
    ]);
  });

  it('ignores non-navigable links', async () => {
    history.replaceState({}, '', '/current');
    await startReplay(BUILD_SLUG, API_ENDPOINT);

    const withoutHref = document.createElement('a');
    withoutHref.textContent = 'Missing href';
    document.body.appendChild(withoutHref);
    const javascriptLink = appendLink({ href: 'javascript:void(0)' });
    const disabledLink = appendLink({ href: '/disabled', disabled: '' });
    const ariaDisabledLink = appendLink({ href: '/aria-disabled', 'aria-disabled': 'true' });

    for (const link of [withoutHref, javascriptLink, disabledLink, ariaDisabledLink]) {
      clickLink(link);
      await settleLinkActivation();
    }

    expect(hoisted.addCustomEvent).not.toHaveBeenCalled();
  });

  it('marks same-document hash activations without dropping them', async () => {
    history.replaceState({}, '', '/docs?tab=api#intro');
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const link = appendLink({ href: '#details' });

    clickLink(link);
    await settleLinkActivation();

    expect(lastLinkActivationCall()).toEqual([
      'link_activation',
      expect.objectContaining({
        href: new URL('/docs?tab=api#details', location.href).href,
        currentHref: new URL('/docs?tab=api#intro', location.href).href,
        sameOrigin: true,
        sameDocument: true,
      }),
    ]);
  });

  it('removes the click listener when replay stops', async () => {
    history.replaceState({}, '', '/current');
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const link = appendLink({ href: '/after-stop' });

    stopReplay();
    clickLink(link);
    await settleLinkActivation();

    expect(hoisted.addCustomEvent).not.toHaveBeenCalled();
  });

  it('does not install inside a cross-origin iframe', async () => {
    history.replaceState({}, '', '/current');
    const ownSelf = Object.getOwnPropertyDescriptor(window, 'self');
    Object.defineProperty(window, 'self', { configurable: true, get: () => ({}) });
    try {
      await startReplay(BUILD_SLUG, API_ENDPOINT);
      const link = appendLink({ href: '/iframe-link' });

      clickLink(link);
      await settleLinkActivation();

      expect(hoisted.addCustomEvent).not.toHaveBeenCalled();
    } finally {
      if (ownSelf) {
        Object.defineProperty(window, 'self', ownSelf);
      } else {
        Reflect.deleteProperty(window, 'self');
      }
    }
  });
});

describe('navigation watcher', () => {
  function lastNavigationCall() {
    const calls = hoisted.addCustomEvent.mock.calls;
    return calls[calls.length - 1] as [string, { href: string; title?: string }];
  }

  it('pushState emits one navigation custom event with href and title', async () => {
    history.replaceState({}, '', '/');
    document.title = 'Dashboard';
    await startReplay(BUILD_SLUG, API_ENDPOINT);

    history.pushState({}, '', '/settings');

    expect(hoisted.addCustomEvent).toHaveBeenCalledTimes(1);
    expect(lastNavigationCall()).toEqual([
      'navigation',
      { href: location.href, title: 'Dashboard' },
    ]);
    expect(location.href).toContain('/settings');
  });

  it('replaceState emits one navigation custom event', async () => {
    history.replaceState({}, '', '/');
    document.title = 'Home';
    await startReplay(BUILD_SLUG, API_ENDPOINT);

    history.replaceState({}, '', '/checkout?step=1');

    expect(hoisted.addCustomEvent).toHaveBeenCalledTimes(1);
    expect(lastNavigationCall()).toEqual([
      'navigation',
      { href: location.href, title: 'Home' },
    ]);
  });

  it('popstate emits one navigation custom event on back/forward', async () => {
    history.replaceState({}, '', '/');
    document.title = 'Page';
    await startReplay(BUILD_SLUG, API_ENDPOINT);

    // Build a history stack so a back navigation restores a different URL.
    history.pushState({}, '', '/first');
    history.pushState({}, '', '/second');
    hoisted.addCustomEvent.mockClear();

    history.back(); // browser restores '/first' and fires popstate
    await vi.waitFor(() => expect(hoisted.addCustomEvent).toHaveBeenCalled());

    expect(hoisted.addCustomEvent).toHaveBeenCalledTimes(1);
    expect(lastNavigationCall()).toEqual([
      'navigation',
      { href: location.href, title: 'Page' },
    ]);
  });

  it('dedupes consecutive navigations to an identical URL', async () => {
    history.replaceState({}, '', '/');
    await startReplay(BUILD_SLUG, API_ENDPOINT);

    history.pushState({}, '', '/repeat?v=1');
    history.replaceState({}, '', '/repeat?v=1'); // same resolved URL — query churn

    expect(hoisted.addCustomEvent).toHaveBeenCalledTimes(1);
  });

  it('stop restores original history methods and fires no event afterwards', async () => {
    history.replaceState({}, '', '/');
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    expect(history.pushState).not.toBe(originalPushState); // patched while recording

    stopReplay();
    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);

    hoisted.addCustomEvent.mockClear();
    history.pushState({}, '', '/after-stop');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(hoisted.addCustomEvent).not.toHaveBeenCalled();
  });

  it('does not install the watcher inside a cross-origin iframe', async () => {
    history.replaceState({}, '', '/');
    const originalPushState = history.pushState;

    // Simulate a cross-origin iframe: window.self !== window.top.
    const ownSelf = Object.getOwnPropertyDescriptor(window, 'self');
    Object.defineProperty(window, 'self', { configurable: true, get: () => ({}) });
    try {
      await startReplay(BUILD_SLUG, API_ENDPOINT);

      // History is left untouched — the watcher never patched it.
      expect(history.pushState).toBe(originalPushState);

      history.pushState({}, '', '/iframe-route');
      expect(hoisted.addCustomEvent).not.toHaveBeenCalled();
    } finally {
      if (ownSelf) {
        Object.defineProperty(window, 'self', ownSelf);
      } else {
        Reflect.deleteProperty(window, 'self');
      }
    }
  });

  it('re-emits a rotated session entry URL even when it matches the prior session', async () => {
    history.replaceState({}, '', '/');
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    // Prime _lastEventAt with a real rrweb event (the first event never rotates).
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });

    // Navigate: the dedup baseline becomes '/dash'.
    history.pushState({}, '', '/dash');
    expect(hoisted.addCustomEvent).toHaveBeenCalledTimes(1);

    // Idle past the threshold, then a real event rotates the session.
    setNow(START_NOW + IDLE_TIMEOUT_MS + 1_000);
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    expect(hoisted.takeFullSnapshot).toHaveBeenCalledWith(true); // rotation happened

    // Same URL as before the rotation. Without the baseline reset this dedupes
    // and the rotated session would carry no navigation event for its entry page.
    hoisted.addCustomEvent.mockClear();
    history.pushState({}, '', '/dash');
    expect(hoisted.addCustomEvent).toHaveBeenCalledTimes(1);
  });

  it('does not stack history wrappers when a prior teardown left one in place', async () => {
    history.replaceState({}, '', '/');
    const genuinePushState = history.pushState;

    // First recording installs our wrapper, then a clean stop restores the original.
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const staleWrapper = history.pushState;
    expect(staleWrapper).not.toBe(genuinePushState);
    stopReplay();
    expect(history.pushState).toBe(genuinePushState);

    // Simulate a hardened host where teardown could NOT restore: the stale wrapper
    // is left on history.pushState (it still carries the genuine original).
    history.pushState = staleWrapper;

    // Second recording must recover the genuine original from the stale wrapper
    // instead of wrapping the wrapper (which would double every navigation event).
    hoisted.addCustomEvent.mockClear();
    await startReplay(BUILD_SLUG, API_ENDPOINT);

    history.pushState({}, '', '/stack-check');
    expect(hoisted.addCustomEvent).toHaveBeenCalledTimes(1);

    stopReplay();
    expect(history.pushState).toBe(genuinePushState); // genuine restored, no wrapper left
  });
});

describe('sessionId wire format', () => {
  // The server validates sessionId as a UUID; any other shape 422-rejects the
  // ENTIRE error batch — silent total telemetry loss for those 5 errors.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('uuid_wire_format: a flushed error sessionId is a server-accepted UUID', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);

    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'wire check',
      stack: null,
      url: null,
      source: 'uncaught',
    });
    stopErrorCapture();

    const [error] = lastFlushedErrors();
    expect(error.sessionId).toMatch(UUID_RE);
  });

  it('uuid_fallback_format: the non-crypto fallback id still matches the UUID shape', async () => {
    // Drop crypto.randomUUID so generateUuid takes the Math.random fallback
    // (restored by vi.unstubAllGlobals in afterEach).
    vi.stubGlobal('crypto', {});

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const sessionId = readStoredSession().id;
    expect(sessionId).toMatch(UUID_RE);

    startErrorCapture(BUILD_SLUG);
    enqueueError({
      message: 'fallback wire check',
      stack: null,
      url: null,
      source: 'uncaught',
    });
    stopErrorCapture();

    const [error] = lastFlushedErrors();
    expect(error.sessionId).toBe(sessionId);
  });
});

describe('visitor identity', () => {
  it('stamps every replay chunk with the visitor id', async () => {
    visibilityState = 'hidden';
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();
    emit!({ type: 2, timestamp: Date.now(), data: {} });

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = parseFetchBody(fetchMock.mock.calls[0]);
    expect(body.visitorId).toBe('visitor-fixed-id');
  });

  it('omits the visitor id from the payload when none is available', async () => {
    vi.mocked(getVisitorId).mockReturnValue(null);
    try {
      visibilityState = 'hidden';
      await startReplay(BUILD_SLUG, API_ENDPOINT);
      const emit = hoisted.getEmit();
      emit!({ type: 2, timestamp: Date.now(), data: {} });

      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const body = parseFetchBody(fetchMock.mock.calls[0]);
      expect(body).not.toHaveProperty('visitorId');
    } finally {
      vi.mocked(getVisitorId).mockReturnValue('visitor-fixed-id');
    }
  });
});

describe('build-bound token', () => {
  async function flushOneChunk(): Promise<Record<string, unknown>> {
    hoisted.getEmit()!({ type: 2, timestamp: Date.now(), data: {} });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    return parseFetchBody(fetchMock.mock.calls[0]);
  }

  it('stamps userEmail and forwards a token bound to this build', async () => {
    visibilityState = 'hidden';
    document.cookie = `bworlds_token=${makeToken({
      email: 'owner@example.com',
      buildSlug: BUILD_SLUG,
    })}`;

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const body = await flushOneChunk();

    expect(body.userEmail).toBe('owner@example.com');
    expect(typeof body.token).toBe('string');
  });

  it('ignores a token cookie issued for another build (no email or token leak)', async () => {
    visibilityState = 'hidden';
    document.cookie = `bworlds_token=${makeToken({
      email: 'someone-else@example.com',
      buildSlug: 'a-different-build',
    })}`;

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const body = await flushOneChunk();

    expect(body).not.toHaveProperty('userEmail');
    expect(body).not.toHaveProperty('token');
  });

  it('decodes a non-ASCII email from a build-bound token', async () => {
    visibilityState = 'hidden';
    document.cookie = `bworlds_token=${makeToken({
      email: 'josé@example.com',
      buildSlug: BUILD_SLUG,
    })}`;

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const body = await flushOneChunk();

    expect(body.userEmail).toBe('josé@example.com');
  });
});

// ---------------------------------------------------------------------------
// Failed replay start un-stamp. These tests force the rrweb DYNAMIC IMPORT to
// fail, which requires a fresh module registry (the top-level mock factory is
// cached after the first import). They stay last in the file: everything
// inside goes through freshly imported module instances, never the static
// imports above.
// ---------------------------------------------------------------------------

describe('failed replay start un-stamp', () => {
  afterEach(() => {
    vi.doUnmock('rrweb');
    vi.resetModules();
  });

  /** Fresh replay/error-capture instances whose `import('rrweb')` rejects. */
  async function loadWithFailingRrwebImport() {
    vi.resetModules();
    vi.doMock('rrweb', () => {
      throw new Error('dynamic import failed');
    });
    const replay = await import('../src/replay');
    const errorCapture = await import('../src/error-capture');
    const sender = await import('../src/telemetry-sender');
    return { replay, errorCapture, sendTelemetry: vi.mocked(sender.sendTelemetry) };
  }

  function flushedErrorsOf(
    sendTelemetry: typeof mockSendTelemetry,
  ): Array<{ sessionId: string | null }> {
    const calls = sendTelemetry.mock.calls;
    const payload = calls[calls.length - 1][1] as {
      errors: Array<{ sessionId: string | null }>;
    };
    return payload.errors;
  }

  it('fresh_session_unstamped: error stamped during a failing rrweb import flushes with a null session id', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { replay, errorCapture, sendTelemetry } = await loadWithFailingRrwebImport();

    // Not awaited yet: the error must be enqueued inside the import window,
    // after _resolveSession published the fresh session id.
    const startPromise = replay.startReplay(BUILD_SLUG, API_ENDPOINT);
    errorCapture.startErrorCapture(BUILD_SLUG);
    errorCapture.enqueueError({
      message: 'during failing import',
      stack: null,
      url: null,
      source: 'uncaught',
    });
    await startPromise;
    errorCapture.stopErrorCapture();

    // The fresh session will never record — its stamp must not reach the wire.
    expect(flushedErrorsOf(sendTelemetry)[0].sessionId).toBeNull();
    warnSpy.mockRestore();
  });

  it('resumed_session_keeps_stamp: a resumed session keeps queued error stamps when the start fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { replay, errorCapture, sendTelemetry } = await loadWithFailingRrwebImport();

    const storedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        id: storedId,
        seq: 3,
        startedAt: START_NOW - 1_000,
        lastActivityAt: START_NOW - 500,
        // origin's _resolveSession only resumes a chunked session (seq > 0)
        // once its first chunk was acked; without this it opens a fresh one,
        // which would (correctly) scrub the stamp instead of keeping it.
        firstChunkAcked: true,
      }),
    );

    const startPromise = replay.startReplay(BUILD_SLUG, API_ENDPOINT);
    errorCapture.startErrorCapture(BUILD_SLUG);
    errorCapture.enqueueError({
      message: 'during failing import (resumed)',
      stack: null,
      url: null,
      source: 'uncaught',
    });
    await startPromise;
    errorCapture.stopErrorCapture();

    // Prior footage exists for a resumed session — the stamp stays.
    expect(flushedErrorsOf(sendTelemetry)[0].sessionId).toBe(storedId);
    warnSpy.mockRestore();
  });
});
