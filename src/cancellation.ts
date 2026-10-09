export type ExpectedCancellationReason = 'cleanup' | 'navigation' | 'replacement';

/** Abort a request because its owning UI no longer needs it, preserving AbortError handling. */
export function abortExpectedRequest(
  controller: AbortController,
  reason: ExpectedCancellationReason,
): void {
  const cancellation = new DOMException(`Expected request cancellation: ${reason}`, 'AbortError');
  // Symbol.for keeps provenance intact when the caller and collector load
  // different SDK bundles, without adding a header or changing the request.
  Object.defineProperty(cancellation, Symbol.for('@bworlds/launchkit/expected-cancellation'), {
    value: reason,
  });
  controller.abort(cancellation);
}
