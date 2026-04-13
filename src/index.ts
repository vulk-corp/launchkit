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

/**
 * Inject a full-screen overlay that hides the app while the access check
 * is in flight. Prevents the "flash of protected content" before redirect.
 * Returns a handle with a `remove()` method to tear it down on success.
 */
function showGateOverlay(): { remove: () => void } {
  const el = document.createElement('div');
  el.id = 'bworlds-gate-overlay';
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('role', 'status');
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#fff',
  } as CSSStyleDeclaration);

  // Spinner + text
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:12px">
      <div style="width:32px;height:32px;border:3px solid #e5e5e5;border-top-color:#333;border-radius:50%;animation:bw-spin .7s linear infinite"></div>
      <p style="font-family:system-ui,sans-serif;font-size:14px;color:#666;margin:0">Verifying access…</p>
    </div>
    <style>@keyframes bw-spin{to{transform:rotate(360deg)}}</style>`;

  document.body.appendChild(el);

  return {
    remove() {
      el.remove();
    },
  };
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

    // Access gating: show loading screen, check token, redirect or reveal app.
    // Skipped in sandboxed iframes (editor previews).
    if (config.gate !== false && !sandboxed) {
      const overlay = showGateOverlay();
      check().then((session) => {
        if (!session.valid) {
          window.location.href = getGateUrl();
        } else {
          overlay.remove();
        }
      });
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
