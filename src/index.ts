import { configureSender } from './telemetry-sender';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { startErrorCapture, stopErrorCapture } from './error-capture';
import type { LaunchKitConfig } from './types';

export type { LaunchKitConfig } from './types';

/**
 * Initialize LaunchKit monitoring (heartbeat + error capture).
 *
 *   init({ buildSlug: 'my-app' })
 */
export function init(config: LaunchKitConfig): void {
  if (typeof window === 'undefined') return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start(config));
  } else {
    start(config);
  }
}

function start(config: LaunchKitConfig): void {
  configureSender({
    buildSlug: config.buildSlug,
    apiEndpoint: config.apiEndpoint,
  });

  if (config.enableHeartbeat !== false) {
    startHeartbeat(config.buildSlug, config.heartbeatInterval);
  }

  if (config.enableErrorCapture !== false) {
    startErrorCapture(config.buildSlug);
  }
}

/**
 * Stop all monitoring. Call on cleanup/unmount if needed.
 */
export function stop(): void {
  stopHeartbeat();
  stopErrorCapture();
}
