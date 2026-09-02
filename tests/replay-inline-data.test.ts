import type { MockInstance } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { startReplay, stopReplay } from '../src/replay';
import { sendTelemetry } from '../src/telemetry-sender';
import {
  INLINE_DATA_PLACEHOLDER,
  MAX_INLINE_DATA_ATTRIBUTE_BYTES,
  scrubInlineData,
} from '../src/replay-inline-data';
import { planChunkRanges, type ChunkRange } from '../src/replay-chunk-plan';

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
const DROP_RESYNC_MIN_INTERVAL_MS = 30_000;
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

/** A mutation just above the capture ceiling, dropped at emit. */
function oversizedMutationEvent() {
  return mutationEvent({ texts: [{ id: 4, value: 'x'.repeat(CAPTURE_CEILING_BYTES + 1) }] });
}

/** Mirror rrweb: takeFullSnapshot re-enters emit synchronously with a FullSnapshot. */
function snapshotThroughEmit(emit: (event: unknown) => void): void {
  hoisted.takeFullSnapshot.mockImplementation(() => emit(fullSnapshotEvent([])));
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

  it('scrubs an inserted stylesheet rule and leaves a small one untouched', () => {
    const inline = inlineImage(48 * KB);
    const largeRule = `.hero{background-image:url("${inline}");color:red}`;
    const smallRule = `.icon{background:url(${inlineImage(2 * KB)}) no-repeat}`;
    const event = {
      type: 3,
      timestamp: Date.now(),
      data: {
        source: 8,
        id: 30,
        adds: [
          { rule: largeRule, index: 0 },
          { rule: smallRule, index: [1, 0] },
        ],
      },
    };

    const result = scrubInlineData(event);

    expect(result).toEqual({ replacedCount: 1, replacedBytes: inline.length + 'url("")'.length });
    expect(event.data.adds[0]).toEqual({
      rule: `.hero{background-image:url(${INLINE_DATA_PLACEHOLDER});color:red}`,
      index: 0,
    });
    expect(event.data.adds[1]).toEqual({ rule: smallRule, index: [1, 0] });
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
// Chunk planning
// ---------------------------------------------------------------------------

describe('planChunkRanges', () => {
  const ENVELOPE_BYTES = 900;

  /**
   * Oracle: a planner that bisects on a full measurement of every candidate
   * range. The estimate-based planner must reproduce its boundaries.
   */
  function referencePlan(
    sizes: number[],
    firstSequenceNumber: number,
    fullSnapshotIndex: number,
  ): ChunkRange[] {
    const measure = (start: number, end: number) =>
      ENVELOPE_BYTES +
      sizes.slice(start, end).reduce((total, size) => total + size, 0) +
      Math.max(0, end - start - 1);
    const split = (start: number, end: number, sequenceNumber: number): number => {
      let mid = start + Math.floor((end - start) / 2);
      if (sequenceNumber === 0 && fullSnapshotIndex >= mid && fullSnapshotIndex < end) {
        mid = fullSnapshotIndex + 1;
      }
      return Math.max(start + 1, Math.min(mid, end - 1));
    };
    const plan = (start: number, end: number, sequenceNumber: number): ChunkRange[] => {
      if (measure(start, end) <= MAX_CHUNK_BYTES || end - start <= 1) return [{ start, end }];
      if (sequenceNumber === 0 && fullSnapshotIndex >= start && fullSnapshotIndex < end) {
        const bootstrapEnd = fullSnapshotIndex + 1;
        if (bootstrapEnd >= end) return [{ start, end }];
        return [{ start, end: bootstrapEnd }, ...plan(bootstrapEnd, end, sequenceNumber + 1)];
      }
      const mid = split(start, end, sequenceNumber);
      const left = plan(start, mid, sequenceNumber);
      return [...left, ...plan(mid, end, sequenceNumber + left.length)];
    };
    return plan(0, sizes.length, firstSequenceNumber);
  }

  it('reproduces the exact planner boundaries for a mixed batch without serializing', () => {
    const sizes = [200_000, 100_000, 300_000, 50_000, 250_000, 10_000, 511_000, 600_000, 1_000];
    const stringify = vi.spyOn(JSON, 'stringify');

    const ranges = planChunkRanges({
      sizes,
      envelopeBytes: ENVELOPE_BYTES,
      budgetBytes: MAX_CHUNK_BYTES,
      firstSequenceNumber: 4,
      fullSnapshotIndex: -1,
    });

    expect(stringify).not.toHaveBeenCalled();
    expect(ranges).toEqual(referencePlan(sizes, 4, -1));
    expect(ranges).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 6 },
      { start: 6, end: 7 },
      { start: 7, end: 8 },
      { start: 8, end: 9 },
    ]);
  });

  it('ends the bootstrap chunk at the FullSnapshot and bisects the rest', () => {
    const sizes = [300, 400_000, 200_000, 300_000, 50_000];
    const ranges = planChunkRanges({
      sizes,
      envelopeBytes: ENVELOPE_BYTES,
      budgetBytes: MAX_CHUNK_BYTES,
      firstSequenceNumber: 0,
      fullSnapshotIndex: 1,
    });
    expect(ranges).toEqual(referencePlan(sizes, 0, 1));
    expect(ranges).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it('never splits a single event and returns nothing for an empty batch', () => {
    expect(
      planChunkRanges({
        sizes: [5_000_000],
        envelopeBytes: ENVELOPE_BYTES,
        budgetBytes: MAX_CHUNK_BYTES,
        firstSequenceNumber: 3,
        fullSnapshotIndex: -1,
      }),
    ).toEqual([{ start: 0, end: 1 }]);
    expect(
      planChunkRanges({
        sizes: [],
        envelopeBytes: ENVELOPE_BYTES,
        budgetBytes: MAX_CHUNK_BYTES,
        firstSequenceNumber: 0,
        fullSnapshotIndex: -1,
      }),
    ).toEqual([]);
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

describe('capture ceiling', () => {
  it('drops an oversized event before buffering, without reserving a sequence number', async () => {
    const emit = await startWithBootstrap();
    const sessionId = readStoredSession().id;
    expect(readStoredSession().seq).toBe(1);

    const oversized = mutationEvent({
      texts: [{ id: 4, value: 'x'.repeat(CAPTURE_CEILING_BYTES + 1) }],
    });
    emit(oversized);
    emit(oversized);
    await flushMacrotask();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readStoredSession().seq).toBe(1);
    expect(replayDiagnostics('event_dropped_at_capture')).toEqual([
      expect.objectContaining({
        sessionId,
        severity: 'warning',
        reason: 'event_too_large',
        rawBytes: expect.any(Number),
        eventCount: 1,
        hasFullSnapshot: false,
      }),
      expect.objectContaining({ sessionId, reason: 'event_too_large', eventCount: 2 }),
    ]);
    expect(replayDiagnostics('event_dropped_at_capture')[0].rawBytes as number).toBeGreaterThan(
      CAPTURE_CEILING_BYTES,
    );
    expect(warningsMatching(warn, 'exceeded the capture ceiling')).toBe(1);

    // Recording continues: the next event still lands on the chunk path.
    emit(fullSnapshotEvent([]));
    await flushMacrotask();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parseUploadBody(fetchMock.mock.calls[1])).toMatchObject({
      sequenceNumber: 1,
      eventCount: 1,
    });
  });

  it('reports the first five drops, the tenth, then every hundredth', async () => {
    const emit = await startWithBootstrap();
    const oversized = mutationEvent({
      texts: [{ id: 4, value: 'x'.repeat(CAPTURE_CEILING_BYTES + 1) }],
    });

    for (let i = 0; i < 12; i += 1) emit(oversized);

    const reports = replayDiagnostics('event_dropped_at_capture');
    expect(reports.map((report) => report.eventCount)).toEqual([1, 2, 3, 4, 5, 10]);
    for (const report of reports) {
      expect(report.rawBytes as number).toBeGreaterThan(CAPTURE_CEILING_BYTES);
    }
    expect(warningsMatching(warn, 'exceeded the capture ceiling')).toBe(1);
  });

  it('keeps a FullSnapshot above the ceiling on the chunk path', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit()!;

    emit({
      type: 2,
      timestamp: Date.now(),
      data: { html: 'x'.repeat(CAPTURE_CEILING_BYTES + 1) },
    });
    await flushMacrotask();

    expect(replayDiagnostics('event_dropped_at_capture')).toEqual([]);
    expect(readStoredSession().seq).toBe(1);
    expect(warningsMatching(warn, 'page snapshot')).toBe(1);
  });
});

describe('resync after a dropped event', () => {
  it('takes one FullSnapshot on a later macrotask and uploads it at the next sequence number', async () => {
    const emit = await startWithBootstrap();
    snapshotThroughEmit(emit);

    emit(oversizedMutationEvent());
    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();

    await flushMacrotask();
    expect(hoisted.takeFullSnapshot).toHaveBeenCalledTimes(1);
    expect(hoisted.takeFullSnapshot).toHaveBeenCalledWith(true);

    await flushMacrotask();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parseUploadBody(fetchMock.mock.calls[1])).toMatchObject({
      sequenceNumber: 1,
      eventCount: 1,
      hasFullSnapshot: true,
    });
  });

  it('coalesces the drops of one task into a single snapshot', async () => {
    const emit = await startWithBootstrap();
    snapshotThroughEmit(emit);

    emit(oversizedMutationEvent());
    emit(oversizedMutationEvent());
    emit(oversizedMutationEvent());
    await flushMacrotask();

    expect(hoisted.takeFullSnapshot).toHaveBeenCalledTimes(1);
  });

  it('defers a drop inside the cooldown to the end of the cooldown', async () => {
    const emit = await startWithBootstrap();
    snapshotThroughEmit(emit);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      emit(oversizedMutationEvent());
      await vi.advanceTimersByTimeAsync(0);
      expect(hoisted.takeFullSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      emit(oversizedMutationEvent());
      await vi.advanceTimersByTimeAsync(0);
      expect(hoisted.takeFullSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(DROP_RESYNC_MIN_INTERVAL_MS - 5_000 - 1);
      expect(hoisted.takeFullSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(hoisted.takeFullSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending resync when recording stops', async () => {
    const emit = await startWithBootstrap();
    emit(oversizedMutationEvent());
    stopReplay();
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    await flushMacrotask();

    expect(hoisted.takeFullSnapshot).not.toHaveBeenCalled();
  });
});

describe('eager flush scheduling', () => {
  it('never flushes synchronously inside emit and coalesces emits from one task', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    const emit = hoisted.getEmit()!;

    emit(fullSnapshotEvent([]));
    emit(fullSnapshotEvent([element(9, 'p')]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readStoredSession().seq).toBe(0);

    await flushMacrotask();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parseUploadBody(fetchMock.mock.calls[0])).toMatchObject({
      sequenceNumber: 0,
      eventCount: 2,
      hasFullSnapshot: true,
    });
  });

  it('cancels a scheduled flush when recording stops', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    hoisted.getEmit()!(fullSnapshotEvent([]));
    stopReplay();
    await flushMacrotask();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chunk planning at flush', () => {
  it('splits a mixed batch on capture estimates and serializes each chunk once', async () => {
    const emit = await startWithBootstrap();
    const sizes = [200_000, 100_000, 300_000, 50_000, 250_000, 10_000];
    sizes.forEach((size, index) => {
      emit(mutationEvent({ texts: [{ id: 4, value: `${index}:${'x'.repeat(size)}` }] }));
    });
    const stringify = vi.spyOn(JSON, 'stringify');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const chunkCount = 3;
    // One envelope measurement and one session persist per flush; every chunk
    // is serialized exactly once, when it is uploaded.
    expect(stringify.mock.calls.length).toBeLessThanOrEqual(chunkCount + 2);

    const chunks = fetchMock.mock.calls.slice(1).map(parseUploadBody);
    const markers = chunks.map((chunk) =>
      (chunk.events as Array<{ data: { texts: Array<{ value: string }> } }>).map(
        (event) => event.data.texts[0].value.split(':')[0],
      ),
    );
    expect(markers).toEqual([['0'], ['1', '2'], ['3', '4', '5']]);
    expect(chunks.map((chunk) => chunk.sequenceNumber)).toEqual([1, 2, 3]);
    for (const chunk of chunks) {
      expect(chunk.rawBytes as number).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it('reports the exact serialized size in rawBytes', async () => {
    await startReplay(BUILD_SLUG, API_ENDPOINT);
    hoisted.getEmit()!(fullSnapshotEvent([element(5, 'p', { title: 'héllo €' })]));
    await flushMacrotask();

    const init = fetchMock.mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body) as { rawBytes: number };
    expect(body.rawBytes).toBe(new TextEncoder().encode(init.body).byteLength);
  });
});

describe('capture cost', () => {
  it('passes a 20 MB inline image event through emit in under 50 ms', async () => {
    const emit = await startWithBootstrap();
    const events = [70, 71, 72].map((id) =>
      mutationEvent({ adds: [addedImage(id, inlineImage(20 * MB))] }),
    );

    // The fastest of three samples: one sample alone flakes on a busy runner.
    const timings = events.map((event) => {
      const startedAt = performance.now();
      emit(event);
      return performance.now() - startedAt;
    });

    expect(Math.min(...timings)).toBeLessThan(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warningsMatching(warn, '(20.0 MB) was replaced by a placeholder')).toBe(1);
  });
});
