const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';

interface SenderConfig {
  buildSlug: string;
  apiEndpoint?: string;
}

let _config: SenderConfig | null = null;

export function configureSender(config: SenderConfig): void {
  _config = config;
}

export async function sendTelemetry(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!_config) return;

  const url = `${_config.apiEndpoint || DEFAULT_API_ENDPOINT}${path}`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch {
    // Silent fail: the SDK must never crash the host app
  }
}
