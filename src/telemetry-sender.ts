const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';

interface SenderConfig {
  buildSlug: string;
  apiEndpoint?: string;
}

/**
 * Stored on globalThis (mirroring session-state) so the config stays shared
 * when CDN ESM providers split LaunchKit across multiple bundle files — a
 * plain module-level variable would leave the replay chunk's copy
 * unconfigured, silently dropping every send from that side.
 */
const SENDER_STATE_KEY = '__bworldsLaunchKitSenderState__';

interface SenderState {
  config: SenderConfig | null;
}

function getState(): SenderState {
  const root = globalThis as typeof globalThis & {
    [SENDER_STATE_KEY]?: SenderState;
  };
  root[SENDER_STATE_KEY] ??= { config: null };
  return root[SENDER_STATE_KEY];
}

export function configureSender(config: SenderConfig): void {
  getState().config = config;
}

export async function sendTelemetry(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const config = getState().config;
  if (!config) return;

  const url = `${config.apiEndpoint || DEFAULT_API_ENDPOINT}${path}`;

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
