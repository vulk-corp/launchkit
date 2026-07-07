/**
 * SDK healthcheck: proves the LaunchKit runtime is alive and configured.
 *
 * This is separate from uptime monitoring. Uptime can be disabled by the
 * builder, but SDK health is system-owned and starts after the origin guard
 * passes.
 */

import { sendTelemetry } from './telemetry-sender';

declare const __SDK_VERSION__: string;

const DEFAULT_INTERVAL_SECONDS = 300;
const JITTER_RATIO = 0.1;

let _timeoutId: ReturnType<typeof setTimeout> | null = null;
let _buildSlug: string | null = null;
let _intervalMs = DEFAULT_INTERVAL_SECONDS * 1000;

export function startSdkHealth(
  buildSlug: string,
  intervalSeconds: unknown = DEFAULT_INTERVAL_SECONDS,
): void {
  if (_timeoutId) return;
  _buildSlug = buildSlug;
  _intervalMs = normalizeIntervalSeconds(intervalSeconds) * 1000;

  sendSdkHealth();
  scheduleNextHealthcheck();
}

export function stopSdkHealth(): void {
  if (_timeoutId) {
    clearTimeout(_timeoutId);
    _timeoutId = null;
  }
  _buildSlug = null;
}

function normalizeIntervalSeconds(intervalSeconds: unknown): number {
  if (
    typeof intervalSeconds === 'number' &&
    Number.isFinite(intervalSeconds) &&
    intervalSeconds > 0
  ) {
    return Math.max(1, intervalSeconds);
  }
  return DEFAULT_INTERVAL_SECONDS;
}

function scheduleNextHealthcheck(): void {
  const jitter = _intervalMs * JITTER_RATIO * (Math.random() * 2 - 1);
  const delayMs = Math.max(1000, Math.round(_intervalMs + jitter));
  _timeoutId = setTimeout(() => {
    sendSdkHealth();
    scheduleNextHealthcheck();
  }, delayMs);
}

async function sendSdkHealth(): Promise<void> {
  if (!_buildSlug) return;
  await sendTelemetry('/api/telemetry/sdk-health', {
    buildSlug: _buildSlug,
    metadata: {
      sdk_version: typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : 'unknown',
    },
  });
}
