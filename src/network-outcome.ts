export type ExpectedNetworkState = 'empty' | 'cancelled';

export function effectiveFetchSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null | undefined {
  try {
    const signal = init?.signal;
    return signal !== undefined
      ? signal
      : typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined;
  } catch {
    return undefined;
  }
}

export function isExpectedRequestCancellation(error: unknown, signal: AbortSignal | null | undefined): boolean {
  try {
    if (!signal?.aborted || error !== signal.reason || error === null || typeof error !== 'object') return false;
    const reason: unknown = Object.getOwnPropertyDescriptor(
      error, Symbol.for('@bworlds/launchkit/expected-cancellation'),
    )?.value;
    return reason === 'cleanup' || reason === 'navigation' || reason === 'replacement';
  } catch {
    return false;
  }
}

export function expectedNetworkState(
  status: number,
  method: string,
  readHeader: (name: string) => string | null,
): ExpectedNetworkState | undefined {
  try {
    return status === 404 && method === 'GET' && readHeader('X-BWorlds-Expected-State') === 'empty'
      ? 'empty'
      : undefined;
  } catch {
    return undefined;
  }
}
