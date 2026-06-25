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
const BUILD_SLUG = 'test-build';
const API_ENDPOINT = 'https://api.test';
const START_NOW = 1_000_000;

interface StoredSession {
  id: string;
  seq: number;
  startedAt: number;
  lastActivityAt: number;
}

const fetchMock = vi.fn();

/** Resolve pending microtasks (fetch promises inside _flushChunk). */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

function parseFetchBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as { body?: string };
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
}

async function parseBeaconBody(call: unknown[]): Promise<Record<string, unknown>> {
  const blob = call[1] as Blob;
  return JSON.parse(await blob.text()) as Record<string, unknown>;
}

function readStoredSession(): StoredSession {
  return JSON.parse(sessionStorage.getItem(STORAGE_KEY)!) as StoredSession;
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

let visibilityState: DocumentVisibilityState = 'visible';
let originalVisibilityDescriptor: PropertyDescriptor | undefined;
let originalSendBeaconDescriptor: PropertyDescriptor | undefined;

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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    emit!(fullSnapshotEvent(false, 'styleless-checkout'));

    await vi.waitFor(() => {
      expect(hoisted.takeFullSnapshot).toHaveBeenCalledWith(true);
    });

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = parseFetchBody(fetchMock.mock.calls[0]);
    const events = body.events as Array<{ data?: { marker?: string } }>;
    expect(events.map((event) => event.data?.marker)).toEqual([
      'initial-styled',
      'retry-styled',
    ]);
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
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    const oldSessionId = readStoredSession().id;

    setNow(START_NOW + IDLE_TIMEOUT_MS + 1_000);
    emit!({ type: 3, timestamp: Date.now(), data: { source: 2 } });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseFetchBody(fetchMock.mock.calls[0]);
    expect(body.sessionId).toBe(oldSessionId);
    expect(body.sequenceNumber).toBe(0);
    expect((body.events as unknown[]).length).toBe(2);
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
    expect(readStoredSession().seq).toBe(0);

    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();
    const latestBody = parseFetchBody(
      fetchMock.mock.calls[fetchMock.mock.calls.length - 1],
    );
    expect(latestBody.sessionId).toBe(newSessionId);
    expect(latestBody.sequenceNumber).toBe(0);
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
    emit!({ type: 2, timestamp: Date.now(), data: {} });

    // Chunk upload hits the daily cap; replay stops itself via stopReplay().
    fetchMock.mockResolvedValue({ ok: false, status: 429 } as Response);
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

  it('keeps sequence numbers monotone when visibilitychange fires during the initial flush', async () => {
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

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(parseFetchBody(fetchMock.mock.calls[0]).sequenceNumber).toBe(0);
    expect(readStoredSession().seq).toBe(1);

    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'during-fetch' } });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFetch(okResponse());
    await flushMicrotasks();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(parseFetchBody(fetchMock.mock.calls[1]).sequenceNumber).toBe(1);
  });

  it('uses the next sequenceNumber for beforeunload sendBeacon during the initial fetch', async () => {
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

    window.dispatchEvent(new Event('beforeunload'));

    expect(parseFetchBody(fetchMock.mock.calls[0]).sequenceNumber).toBe(0);
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    expect(
      (await parseBeaconBody(sendBeaconMock.mock.calls[0])).sequenceNumber,
    ).toBe(1);

    releaseFetch(okResponse());
    await flushMicrotasks();
  });

  it('retries a failed chunk with the same sequenceNumber and payload', async () => {
    visibilityState = 'hidden';
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValue(okResponse());

    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit();

    emit!({ type: 2, timestamp: Date.now(), data: { marker: 'initial' } });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    const failedBody = parseFetchBody(fetchMock.mock.calls[0]);
    expect(failedBody.sequenceNumber).toBe(0);

    emit!({ type: 3, timestamp: Date.now(), data: { marker: 'after-failure' } });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const retryBody = parseFetchBody(fetchMock.mock.calls[1]);
    expect(retryBody.sequenceNumber).toBe(0);
    expect(retryBody.events).toEqual(failedBody.events);

    await flushMicrotasks();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(parseFetchBody(fetchMock.mock.calls[2]).sequenceNumber).toBe(1);
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

describe('stopReplay cleanup', () => {
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
