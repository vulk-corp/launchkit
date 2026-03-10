/**
 * Shared HTTP client for sending telemetry data to the BWORLDS API.
 * Used by both heartbeat and error-capture modules.
 *
 * No API key required. Requests are identified by buildSlug only.
 */

const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';

interface TelemetrySenderConfig {
  buildSlug: string;
  apiEndpoint?: string;
}

let _config: TelemetrySenderConfig | null = null;

export function configureSender(config: TelemetrySenderConfig): void {
  _config = config;
}

export function getBuildSlug(): string | null {
  return _config?.buildSlug ?? null;
}

export async function sendTelemetry(
  path: string,
  body: Record<string, unknown>
): Promise<boolean> {
  if (!_config) return false;

  const url = `${_config.apiEndpoint || DEFAULT_API_ENDPOINT}${path}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    keepalive: true,
  });

  return response.ok;
}
