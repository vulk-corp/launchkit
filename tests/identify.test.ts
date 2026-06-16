/**
 * Tests for identify() API and UA first-chunk-only capture.
 * Slugs: sdk_identify_api, sdk_cookie_email_auto, sdk_ua_first_chunk_only
 */

import { identify, _getIdentity } from '../src/index';
import { startReplay, stopReplay } from '../src/replay';
import { resetIdentity } from '../src/identity-state';

// ---------------------------------------------------------------------------
// rrweb mock
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

const BUILD_SLUG = 'test-build';
const API_ENDPOINT = 'https://api.test';
const START_NOW = 1_000_000;

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

function parseFetchBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as { body?: string };
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
}

const fetchMock = vi.fn();

let origVisibilityDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START_NOW);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  vi.stubGlobal('fetch', fetchMock);
  hoisted.setEmit(null);
  hoisted.stopRecording.mockClear();
  hoisted.takeFullSnapshot.mockClear();
  hoisted.recordFactory.mockClear();
  // Reset shared identity state between tests
  resetIdentity();
  // Reset cookie
  Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
  // Clear sessionStorage so _resolveSession always starts fresh (sequenceNumber=0)
  sessionStorage.clear();
  // Save original visibility descriptor
  origVisibilityDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
});

afterEach(async () => {
  // Restore visibility to visible before stopReplay so any pending handlers don't flush
  if (origVisibilityDescriptor) {
    Object.defineProperty(Document.prototype, 'visibilityState', origVisibilityDescriptor);
  } else {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  }
  stopReplay();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetIdentity();
  Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true });
});

function setDocHidden() {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'hidden',
  });
}

async function triggerFlush(ts = START_NOW) {
  const emit = hoisted.getEmit();
  emit?.({ type: 2, timestamp: ts, data: {} });
  setDocHidden();
  document.dispatchEvent(new Event('visibilitychange'));
  await flushMicrotasks();
}

// ---------------------------------------------------------------------------
// test_req_sdk_identify_api
// ---------------------------------------------------------------------------

it('req_sdk_identify_api — identify() stores email/userId; first chunk payload carries them', async () => {
  await startReplay(BUILD_SLUG, API_ENDPOINT, { getIdentity: _getIdentity });

  identify({ email: 'alice@example.com', userId: 'user_42' });

  const identity = _getIdentity();
  expect(identity.email).toBe('alice@example.com');
  expect(identity.userId).toBe('user_42');

  await triggerFlush();

  expect(fetchMock).toHaveBeenCalled();
  const body = parseFetchBody(fetchMock.mock.calls[0]);
  expect(body.userEmail).toBe('alice@example.com');
  expect(body.userId).toBe('user_42');
});

// ---------------------------------------------------------------------------
// test_req_sdk_cookie_email_auto
// ---------------------------------------------------------------------------

it('req_sdk_cookie_email_auto — email from bworlds_token cookie in first chunk', async () => {
  function makeJwt(payload: Record<string, unknown>): string {
    // Base64url encode without padding
    const enc = (s: string) =>
      btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const header = enc(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const claims = enc(JSON.stringify(payload));
    return `${header}.${claims}.fakesig`;
  }

  const token = makeJwt({ email: 'cookie@example.com', buildSlug: 'test', accessType: 'full' });
  Object.defineProperty(document, 'cookie', {
    value: `bworlds_token=${token}`,
    writable: true,
    configurable: true,
  });

  await startReplay(BUILD_SLUG, API_ENDPOINT);
  await triggerFlush();

  expect(fetchMock).toHaveBeenCalled();
  const body = parseFetchBody(fetchMock.mock.calls[0]);
  expect(body.userEmail).toBe('cookie@example.com');
});

// ---------------------------------------------------------------------------
// test_req_sdk_ua_first_chunk_only
// ---------------------------------------------------------------------------

it('req_sdk_ua_first_chunk_only — userAgent captured on startReplay, sent on first chunk only', async () => {
  // jsdom has a real navigator.userAgent; we just verify the UA field is populated on first chunk
  // and that isFirstChunk flag is correct
  await startReplay(BUILD_SLUG, API_ENDPOINT, { getIdentity: _getIdentity });

  // First flush
  await triggerFlush();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const firstBody = parseFetchBody(fetchMock.mock.calls[0]);

  // userAgent should be navigator.userAgent (jsdom has a real UA string)
  if (navigator.userAgent) {
    expect(firstBody.userAgent).toBe(navigator.userAgent);
  }
  expect(firstBody.isFirstChunk).toBe(true);

  // Second flush: re-visible, emit another event, re-hide
  fetchMock.mockClear();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
  const emit = hoisted.getEmit();
  emit?.({ type: 3, timestamp: START_NOW + 500, data: {} });
  setDocHidden();
  document.dispatchEvent(new Event('visibilitychange'));
  await flushMicrotasks();

  if (fetchMock.mock.calls.length > 0) {
    const secondBody = parseFetchBody(fetchMock.mock.calls[0]);
    // Second chunk must NOT include userAgent
    expect(secondBody.userAgent).toBeUndefined();
    expect(secondBody.isFirstChunk).toBe(false);
  }
});
