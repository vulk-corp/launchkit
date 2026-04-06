import { configureSender } from './telemetry-sender';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { startErrorCapture, stopErrorCapture } from './error-capture';
import { check as _check } from './check';
import type { LaunchKitConfig } from './types';

export type { LaunchKitConfig } from './types';
export type { CheckResult } from './check';

const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';

export interface LaunchKitInstance {
  /**
   * Validate the current client's access token.
   * No arguments — the token is read from ?bworlds_token= or a cookie automatically.
   *
   * Remove this call (and the redirect below) if you want your app open to everyone.
   *
   *   const session = await launchkit.check();
   *   if (!session.valid) redirect(launchkit.getGateUrl());
   */
  check: () => ReturnType<typeof _check>;
  /**
   * Returns the BWORLDS gate page URL. Redirect unauthorized clients here.
   */
  getGateUrl: () => string;
  /**
   * Stop all monitoring. Call on cleanup/unmount if needed.
   */
  stop: () => void;
}

/**
 * Initialize LaunchKit monitoring (heartbeat + error capture) and return
 * an instance for access gating.
 *
 *   const launchkit = init({ buildSlug: 'my-app' })
 *
 * Activates heartbeat monitoring and error tracking automatically.
 */
export function init(config: LaunchKitConfig): LaunchKitInstance {
  if (typeof window !== 'undefined') {
    const apiEndpoint = config.apiEndpoint ?? DEFAULT_API_ENDPOINT;

    configureSender({ buildSlug: config.buildSlug, apiEndpoint });

    if (config.enableHeartbeat !== false) {
      startHeartbeat(config.buildSlug, config.heartbeatInterval);
    }

    if (config.enableErrorCapture !== false) {
      startErrorCapture(config.buildSlug);
    }
  }

  const apiEndpoint = config.apiEndpoint ?? DEFAULT_API_ENDPOINT;

  return {
    check: () => _check(config.buildSlug, apiEndpoint),
    getGateUrl: () => `https://app.bworlds.co/access/${config.buildSlug}`,
    stop: () => {
      stopHeartbeat();
      stopErrorCapture();
    },
  };
}

/**
 * Stop all monitoring. Convenience export — prefer instance.stop() instead.
 */
export function stop(): void {
  stopHeartbeat();
  stopErrorCapture();
}
