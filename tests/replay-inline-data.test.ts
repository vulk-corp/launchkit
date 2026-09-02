import type { MockInstance } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { startReplay, stopReplay } from '../src/replay';
import { sendTelemetry } from '../src/telemetry-sender';
import {
  INLINE_DATA_PLACEHOLDER,
  MAX_INLINE_DATA_ATTRIBUTE_BYTES,
  scrubInlineData,
} from '../src/replay-inline-data';

vi.mock('../src/telemetry-sender', () => ({
  sendTelemetry: vi.fn(),
}));

vi.mock('../src/visitor-state', () => ({
  getVisitorId: vi.fn(() => 'visitor-fixed-id'),
}));

const mockSendTelemetry = vi.mocked(sendTelemetry);

const hoisted = vi.hoisted(() => {
  let capturedEmit: ((event: unknown) => void) | null = null;
  return {
    getEmit: () => capturedEmit,
    setEmit: (emit: ((event: unknown) => void) | null) => {
      capturedEmit = emit;
    },
    stopRecording: vi.fn(),
    takeFullSnapshot: vi.fn(),
    addCustomEvent: vi.fn(),
  };
});

vi.mock('rrweb', () => {
  const record = Object.assign(
    (opts: { emit: (event: unknown) => void }) => {
      hoisted.setEmit(opts.emit);
      return hoisted.stopRecording;
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
// Fixtures
// ---------------------------------------------------------------------------

const BUILD_SLUG = 'test-build';
const API_ENDPOINT = 'https://api.test';
const STORAGE_KEY = 'bworlds-replay-session';
const MAX_CHUNK_BYTES = 512_000;
const CAPTURE_CEILING_BYTES = 4 * MAX_CHUNK_BYTES;
const KB = 1024;
const MB = 1024 * 1024;

const fetchMock = vi.fn();

/** Let the eager flush macrotask (and any microtask it spawns) run. */
const flushMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type SnapshotNode = {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SnapshotNode[];
  textContent?: string;
};

/** A data URL of exactly `length` characters. */
function inlineImage(length: number): string {
  const prefix = 'data:image/jpeg;base64,';
  return prefix + 'A'.repeat(Math.max(0, length - prefix.length));
}

function element(
  id: number,
  tagName: string,
  attributes: Record<string, unknown> = {},
  childNodes: SnapshotNode[] = [],
): SnapshotNode {
  return { type: 2, id, tagName, attributes, childNodes };
}

function fullSnapshotEvent(bodyChildren: SnapshotNode[]) {
  return {
    type: 2,
    timestamp: Date.now(),
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          element(2, 'html', {}, [element(3, 'head'), element(4, 'body', {}, bodyChildren)]),
        ],
      },
      initialOffset: { top: 0, left: 0 },
    },
  };
}

function mutationEvent(data: Record<string, unknown>) {
  return {
    type: 3,
    timestamp: Date.now(),
    data: { source: 0, texts: [], attributes: [], removes: [], adds: [], ...data },
  };
}

function addedImage(id: number, src: string) {
  return { parentId: 4, nextId: null, node: element(id, 'img', { src, alt: `image ${id}` }) };
}

function countNodes(node: SnapshotNode): number {
  return 1 + (node.childNodes ?? []).reduce((total, child) => total + countNodes(child), 0);
}

function readStoredSession(): { id: string; seq: number } {
  return JSON.parse(sessionStorage.getItem(STORAGE_KEY)!) as { id: string; seq: number };
}

function replayDiagnostics(type: string): Array<Record<string, unknown>> {
  return mockSendTelemetry.mock.calls
    .filter(([path]) => path === '/api/telemetry/replay-diagnostics')
    .flatMap(([, payload]) => (payload as { diagnostics: Array<Record<string, unknown>> }).diagnostics)
    .filter((diagnostic) => diagnostic.type === type);
}

function parseUploadBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as { body: string | ArrayBuffer };
  const text =
    typeof init.body === 'string'
      ? init.body
      : strFromU8(gunzipSync(new Uint8Array(init.body)));
  return JSON.parse(text) as Record<string, unknown>;
}

function warningsMatching(warn: MockInstance<typeof console.warn>, needle: string): number {
  return warn.mock.calls.filter(([message]) => String(message).includes(needle)).length;
}

async function startWithBootstrap(): Promise<(event: unknown) => void> {
  await startReplay(BUILD_SLUG, API_ENDPOINT);
  const emit = hoisted.getEmit()!;
  emit(fullSnapshotEvent([]));
  await flushMacrotask();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return emit;
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  mockSendTelemetry.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  vi.stubGlobal('fetch', fetchMock);
  hoisted.setEmit(null);
  hoisted.stopRecording.mockClear();
  hoisted.takeFullSnapshot.mockReset();
  hoisted.addCustomEvent.mockReset();
  sessionStorage.clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  stopReplay();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scrub
// ---------------------------------------------------------------------------

describe('scrubInlineData', () => {
  it('replaces an oversized FullSnapshot img src and keeps the rest of the node', () => {
    const image = element(5, 'img', {
      src: inlineImage(200 * KB),
      alt: 'holiday photo',
      class: 'gallery-item',
      width: '320',
    });
    const event = fullSnapshotEvent([element(6, 'div', { class: 'gallery' }, [image])]);
    const nodeCountBefore = countNodes(event.data.node);

    const result = scrubInlineData(event);

    expect(result).toEqual({ replacedCount: 1, replacedBytes: 200 * KB });
    expect(image.attributes).toEqual({
      src: INLINE_DATA_PLACEHOLDER,
      alt: 'holiday photo',
      class: 'gallery-item',
      width: '320',
    });
    expect(countNodes(event.data.node)).toBe(nodeCountBefore);
  });

  it('replaces only the oversized values in mutation adds and attribute changes', () => {
    const largeAdd = addedImage(10, inlineImage(100 * KB));
    const smallAdd = addedImage(11, inlineImage(10 * KB));
    const largeChange = { id: 12, attributes: { src: inlineImage(64 * KB), alt: 'changed' } };
    const smallChange = { id: 13, attributes: { src: inlineImage(1 * KB) } };
    const event = mutationEvent({
      adds: [largeAdd, smallAdd],
      attributes: [largeChange, smallChange],
    });

    const result = scrubInlineData(event);

    expect(result).toEqual({ replacedCount: 2, replacedBytes: 164 * KB });
    expect(largeAdd.node.attributes!.src).toBe(INLINE_DATA_PLACEHOLDER);
    expect(smallAdd.node.attributes!.src).toBe(inlineImage(10 * KB));
    expect(largeChange.attributes).toEqual({ src: INLINE_DATA_PLACEHOLDER, alt: 'changed' });
    expect(smallChange.attributes.src).toBe(inlineImage(1 * KB));
  });

  it('replaces only the url(data:...) token inside an oversized style attribute', () => {
    const inline = inlineImage(50 * KB);
    const style = `color:red;background-image:url(${inline});margin:0`;
    const box = element(7, 'div', { style, class: 'hero' });
    const event = fullSnapshotEvent([box]);

    const result = scrubInlineData(event);

    expect(result).toEqual({ replacedCount: 1, replacedBytes: inline.length + 'url()'.length });
    expect(box.attributes!.style).toBe(
      `color:red;background-image:url(${INLINE_DATA_PLACEHOLDER});margin:0`,
    );
    expect(box.attributes!.class).toBe('hero');
  });

  it('scrubs a mutation style diff and an inlined stylesheet', () => {
    const inline = inlineImage(40 * KB);
    const styleDiff = {
      'background-image': `url("${inline}")`,
      color: 'red',
      border: ['1px solid', 'important'],
    };
    const cssText = `.hero{background:url('${inline}') no-repeat}@font-face{font-family:x;src:url(data:font/woff2;base64,AAAA)}`;
    const sheet = element(8, 'style', { _cssText: cssText });
    const event = mutationEvent({
      adds: [{ parentId: 3, nextId: null, node: sheet }],
      attributes: [{ id: 9, attributes: { style: styleDiff } }],
    });

    const result = scrubInlineData(event);

    expect(result.replacedCount).toBe(2);
    expect(styleDiff['background-image']).toBe(`url(${INLINE_DATA_PLACEHOLDER})`);
    expect(styleDiff.color).toBe('red');
    expect(styleDiff.border).toEqual(['1px solid', 'important']);
    expect(sheet.attributes!._cssText).toBe(
      `.hero{background:url(${INLINE_DATA_PLACEHOLDER}) no-repeat}@font-face{font-family:x;src:url(data:font/woff2;base64,AAAA)}`,
    );
  });

  it('covers srcset, poster and xlink:href, and leaves everything else alone', () => {
    const remote = `https://cdn.test/${'a'.repeat(100 * KB)}.jpg`;
    const picture = element(20, 'source', { srcset: `${inlineImage(60 * KB)} 2x` });
    const video = element(21, 'video', { poster: inlineImage(60 * KB), src: remote });
    const use = element(22, 'use', { 'xlink:href': inlineImage(60 * KB) });
    const link = element(23, 'a', { href: 'https://example.test/' + 'b'.repeat(40 * KB) });
    const event = fullSnapshotEvent([picture, video, use, link]);

    const result = scrubInlineData(event);

    expect(result.replacedCount).toBe(3);
    expect(picture.attributes!.srcset).toBe(INLINE_DATA_PLACEHOLDER);
    expect(video.attributes!.poster).toBe(INLINE_DATA_PLACEHOLDER);
    expect(video.attributes!.src).toBe(remote);
    expect(use.attributes!['xlink:href']).toBe(INLINE_DATA_PLACEHOLDER);
    expect(link.attributes!.href).toBe('https://example.test/' + 'b'.repeat(40 * KB));
  });

  it('passes through other events and malformed input without throwing', () => {
    const scroll = { type: 3, timestamp: 1, data: { source: 3, id: 1, x: 0, y: 0 } };
    const custom = { type: 5, timestamp: 1, data: { tag: 'x', payload: inlineImage(1 * MB) } };
    expect(scrubInlineData(scroll)).toEqual({ replacedCount: 0, replacedBytes: 0 });
    expect(scrubInlineData(custom)).toEqual({ replacedCount: 0, replacedBytes: 0 });
    expect(custom.data.payload.length).toBe(1 * MB);

    for (const input of [null, undefined, 42, 'event', { type: 2 }, { type: 2, data: null }]) {
      expect(scrubInlineData(input)).toEqual({ replacedCount: 0, replacedBytes: 0 });
    }
    expect(scrubInlineData({ type: 2, data: { node: null } })).toEqual({
      replacedCount: 0,
      replacedBytes: 0,
    });
    expect(
      scrubInlineData({ type: 3, data: { source: 0, adds: [null, { node: 3 }], attributes: [7] } }),
    ).toEqual({ replacedCount: 0, replacedBytes: 0 });
  });

  it('leaves a value exactly at the threshold untouched', () => {
    const image = element(5, 'img', { src: inlineImage(MAX_INLINE_DATA_ATTRIBUTE_BYTES) });
    expect(scrubInlineData(fullSnapshotEvent([image]))).toEqual({
      replacedCount: 0,
      replacedBytes: 0,
    });
    expect(image.attributes!.src).toBe(inlineImage(MAX_INLINE_DATA_ATTRIBUTE_BYTES));
  });
});

// ---------------------------------------------------------------------------
// Capture path
// ---------------------------------------------------------------------------

describe('inline data at capture', () => {
  it('warns once and sends one diagnostic per session across ten scrubbed events', async () => {
    const emit = await startWithBootstrap();
    const sessionId = readStoredSession().id;

    for (let i = 0; i < 10; i += 1) {
      emit(mutationEvent({ adds: [addedImage(100 + i, inlineImage(100 * KB))] }));
    }

    expect(warningsMatching(warn, 'inline base64 image')).toBe(1);
    expect(warn.mock.calls.map(([message]) => String(message))).toContainEqual(
      expect.stringContaining('(100 KB) was replaced by a placeholder'),
    );
    expect(replayDiagnostics('inline_data_scrubbed')).toEqual([
      expect.objectContaining({
        sessionId,
        severity: 'warning',
        eventCount: 1,
        rawBytes: 100 * KB,
      }),
    ]);
  });

  it('uploads placeholders instead of the photos', async () => {
    const emit = await startWithBootstrap();

    emit(
      mutationEvent({
        adds: [addedImage(50, inlineImage(2 * MB)), addedImage(51, inlineImage(2 * MB))],
      }),
    );
    emit(fullSnapshotEvent([element(52, 'img', { src: inlineImage(3 * MB) })]));
    await flushMacrotask();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = parseUploadBody(fetchMock.mock.calls[1]);
    const serialized = JSON.stringify(body.events);
    expect(serialized.length).toBeLessThan(64 * KB);
    expect(serialized.split(INLINE_DATA_PLACEHOLDER).length - 1).toBe(3);
    expect(warningsMatching(warn, '2 inline base64 images (4.0 MB)')).toBe(1);
  });
});

describe('capture cost', () => {
  it('passes a 20 MB inline image event through emit in under 50 ms', async () => {
    const emit = await startWithBootstrap();
    const event = mutationEvent({ adds: [addedImage(70, inlineImage(20 * MB))] });

    const startedAt = performance.now();
    emit(event);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warningsMatching(warn, '(20.0 MB) was replaced by a placeholder')).toBe(1);
  });
});
