/**
 * Chunk planning over per-event size estimates.
 *
 * Every buffered event carries the size its JSON form had at capture, so a
 * flush picks chunk boundaries from a prefix sum without serializing any
 * event. A chunk's estimated payload is the envelope
 * (everything in the upload body except the events) plus its events and the
 * commas between them; the caller measures the envelope once per plan.
 */

export interface ChunkRange {
  /** Index of the first event in the chunk. */
  start: number;
  /** Index one past the last event in the chunk. */
  end: number;
}

export interface ChunkPlanInput {
  /** Per-event JSON size estimate, in buffer order. */
  sizes: number[];
  /** Bytes of the upload body with an empty events array. */
  envelopeBytes: number;
  /** Largest estimated payload a chunk may reach. */
  budgetBytes: number;
  /** Sequence number the first chunk will carry. */
  firstSequenceNumber: number;
  /** Index of the FullSnapshot in `sizes`, or -1 when there is none. */
  fullSnapshotIndex: number;
}

/**
 * Split events into consecutive ranges whose estimated payload fits the budget.
 * A session's bootstrap (sequence 0) ends with its FullSnapshot so the first
 * chunk alone makes the session replayable; later ranges bisect until they fit.
 * A single event never splits, whatever its size.
 */
export function planChunkRanges(input: ChunkPlanInput): ChunkRange[] {
  const { sizes, envelopeBytes, budgetBytes, firstSequenceNumber, fullSnapshotIndex } = input;
  if (sizes.length === 0) return [];

  const prefixSums = new Array<number>(sizes.length + 1);
  prefixSums[0] = 0;
  for (let i = 0; i < sizes.length; i += 1) prefixSums[i + 1] = prefixSums[i] + sizes[i];

  const estimatedPayloadBytes = (start: number, end: number): number =>
    envelopeBytes + (prefixSums[end] - prefixSums[start]) + Math.max(0, end - start - 1);

  const plan = (start: number, end: number, sequenceNumber: number): ChunkRange[] => {
    if (end - start <= 1 || estimatedPayloadBytes(start, end) <= budgetBytes) {
      return [{ start, end }];
    }

    if (sequenceNumber === 0 && fullSnapshotIndex >= start && fullSnapshotIndex < end) {
      const bootstrapEnd = fullSnapshotIndex + 1;
      if (bootstrapEnd >= end) return [{ start, end }];
      return [{ start, end: bootstrapEnd }, ...plan(bootstrapEnd, end, sequenceNumber + 1)];
    }

    const mid = splitPoint(start, end, sequenceNumber, fullSnapshotIndex);
    const left = plan(start, mid, sequenceNumber);
    return [...left, ...plan(mid, end, sequenceNumber + left.length)];
  };

  return plan(0, sizes.length, firstSequenceNumber);
}

function splitPoint(
  start: number,
  end: number,
  sequenceNumber: number,
  fullSnapshotIndex: number,
): number {
  let mid = start + Math.floor((end - start) / 2);
  if (
    sequenceNumber === 0 &&
    fullSnapshotIndex >= start &&
    fullSnapshotIndex < end &&
    fullSnapshotIndex >= mid
  ) {
    mid = fullSnapshotIndex + 1;
  }
  return Math.max(start + 1, Math.min(mid, end - 1));
}
