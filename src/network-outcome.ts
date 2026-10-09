export type ExpectedNetworkState = 'empty';

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
