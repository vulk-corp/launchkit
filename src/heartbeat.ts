/**
 * Heartbeat module: sends periodic pings to the BWORLDS API
 * proving the app is alive and reachable.
 *
 * Default interval: 5 minutes (300000ms).
 */

import { sendTelemetry } from './telemetry-sender';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let _intervalId: ReturnType<typeof setInterval> | null = null;
let _buildSlug: string | null = null;

export function startHeartbeat(
  buildSlug: string,
  intervalMs: number = DEFAULT_INTERVAL_MS
): void {
  if (_intervalId) return; // Already running
  _buildSlug = buildSlug;

  // Send initial heartbeat immediately
  sendHeartbeat();

  // Then send periodically
  _intervalId = setInterval(sendHeartbeat, intervalMs);
}

export function stopHeartbeat(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}

async function sendHeartbeat(): Promise<void> {
  if (!_buildSlug) return;
  await sendTelemetry('/api/telemetry/heartbeat', {
    buildSlug: _buildSlug,
  });
}
