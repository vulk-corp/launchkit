import { abortExpectedRequest, type ExpectedCancellationReason } from '../src/cancellation';
import { isExpectedRequestCancellation } from '../src/network-outcome';

const reasons: ExpectedCancellationReason[] = ['cleanup', 'navigation', 'replacement'];

describe('abortExpectedRequest', () => {
  it.each(reasons)('aborts with a non-enumerable %s provenance and compatible AbortError', (cause) => {
    const controller = new AbortController();

    abortExpectedRequest(controller, cause);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason.name).toBe('AbortError');
    expect(Object.getOwnPropertyDescriptor(
      controller.signal.reason, Symbol.for('@bworlds/launchkit/expected-cancellation'),
    )).toEqual({ value: cause, writable: false, enumerable: false, configurable: false });
  });

  it('preserves an earlier abort rather than relabelling it as expected', () => {
    const controller = new AbortController();
    const timeout = new DOMException('Timed out', 'TimeoutError');
    controller.abort(timeout);

    abortExpectedRequest(controller, 'cleanup');

    expect(controller.signal.reason).toBe(timeout);
    expect(isExpectedRequestCancellation(timeout, controller.signal)).toBe(false);
  });

  it('recognizes the helper from a separately loaded SDK module', async () => {
    vi.resetModules();
    const otherCopy = await import('../src/cancellation');
    const controller = new AbortController();

    otherCopy.abortExpectedRequest(controller, 'navigation');

    expect(otherCopy.abortExpectedRequest).not.toBe(abortExpectedRequest);
    expect(isExpectedRequestCancellation(controller.signal.reason, controller.signal)).toBe(true);
  });
});
