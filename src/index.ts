import { configureSender } from './telemetry-sender';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { startErrorCapture, stopErrorCapture } from './error-capture';
import { check as _check } from './check';
import type { LaunchKitConfig } from './types';

export type { LaunchKitConfig } from './types';
export type { CheckResult } from './check';

const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';

// Module-level state set by init(), read by standalone check/getGateUrl.
let _buildSlug: string | null = null;
let _apiEndpoint = DEFAULT_API_ENDPOINT;

/** True when the app runs inside a cross-origin iframe (e.g. Lovable editor). */
function isSandboxed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin restriction — definitely sandboxed
    return true;
  }
}

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
  _buildSlug = config.buildSlug;
  _apiEndpoint = config.apiEndpoint ?? DEFAULT_API_ENDPOINT;

  if (typeof window !== 'undefined') {
    const sandboxed = isSandboxed();

    configureSender({ buildSlug: _buildSlug, apiEndpoint: _apiEndpoint });

    if (config.enableHeartbeat !== false) {
      startHeartbeat(_buildSlug, config.heartbeatInterval);
    }

    // Error capture only runs in production (top-level window).
    // Sandboxed iframes (e.g. Lovable/Bolt editor) are skipped.
    if (config.enableErrorCapture !== false && !sandboxed) {
      startErrorCapture(_buildSlug);
    }
  }

  return { check, getGateUrl, stop };
}

/**
 * Validate the current client's access token.
 * Standalone export — works after init() has been called.
 *
 *   import { check, getGateUrl } from '@bworlds/launchkit';
 *   const session = await check();
 *   if (!session.valid) window.location.href = getGateUrl();
 */
export function check(): ReturnType<typeof _check> {
  if (!_buildSlug) {
    console.warn('[LaunchKit] check() called before init(). Failing open.');
    return Promise.resolve({
      valid: true,
      email: null,
      accessType: null,
      expiresAt: null,
      degraded: true,
    });
  }
  return _check(_buildSlug, _apiEndpoint);
}

/**
 * Returns the BWORLDS gate page URL.
 * Standalone export — works after init() has been called.
 */
export function getGateUrl(): string {
  if (!_buildSlug) {
    console.warn('[LaunchKit] getGateUrl() called before init().');
    return '';
  }
  return `https://app.bworlds.co/access/${_buildSlug}`;
}

/**
 * Stop all monitoring.
 */
export function stop(): void {
  stopHeartbeat();
  stopErrorCapture();
}
