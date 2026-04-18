import { startReplay, stopReplay } from '../src/replay';

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
    recordFactory: vi.fn(),
  };
});

vi.mock('rrweb', () => {
  const record = Object.assign(
    (opts: { emit: (event: unknown) => void }) => {
      hoisted.setEmit(opts.emit);
      hoisted.recordFactory(opts);
      return hoisted.stopRecording;
    },
    { takeFullSnapshot: hoisted.takeFullSnapshot },
  );
  return {
    record,
    EventType: { Custom: 5, FullSnapshot: 2, IncrementalSnapshot: 3 },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 4 * 60 * 1000;
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

function readStoredSession(): StoredSession {
  return JSON.parse(sessionStorage.getItem(STORAGE_KEY)!) as StoredSession;
}

function okResponse() {
  return { ok: true, status: 200 } as Response;
}

function setNow(ms: number) {
  vi.setSystemTime(ms);
}

let visibilityState: DocumentVisibilityState = 'visible';
let originalVisibilityDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(START_NOW);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
  hoisted.setEmit(null);
  hoisted.stopRecording.mockClear();
  hoisted.takeFullSnapshot.mockClear();
  hoisted.recordFactory.mockClear();
  sessionStorage.clear();
  visibilityState = 'visible';
  originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
    Document.prototype,
    'visibilityState',
  );
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
});

afterEach(() => {
  stopReplay();
  if (originalVisibilityDescriptor) {
    Object.defineProperty(
      Document.prototype,
      'visibilityState',
      originalVisibilityDescriptor,
    );
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
