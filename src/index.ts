import { configureSender } from './telemetry-sender';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { startErrorCapture, stopErrorCapture } from './error-capture';
import { check as _check } from './check';
import { fetchRemoteConfig } from './remote-config';
import type { LaunchKitConfig } from './types';

export type { LaunchKitConfig } from './types';
export type { CheckResult } from './check';

const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';
const DEFAULT_GATE_ORIGIN = 'https://app.bworlds.co';

// Module-level state set by init(), read by standalone check/getGateUrl.
let _buildSlug: string | null = null;
let _apiEndpoint = DEFAULT_API_ENDPOINT;
let _gateOrigin = DEFAULT_GATE_ORIGIN;

// Module-level ref for the dynamically-imported stopReplay function
let _stopReplay: (() => void) | null = null;

/** True when the app runs inside a cross-origin iframe (e.g. Lovable editor). */
function isSandboxed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Inject a full-screen overlay that hides the app while the access check
 * is in flight. Prevents the "flash of protected content" before redirect.
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

  // Static spinner markup, no user input (safe innerHTML)
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:12px">
      <div style="width:32px;height:32px;border:3px solid #e5e5e5;border-top-color:#333;border-radius:50%;animation:bw-spin .7s linear infinite"></div>
      <p style="font-family:system-ui,sans-serif;font-size:14px;color:#666;margin:0">Verifying access\u2026</p>
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
   * No arguments -- the token is read from ?bworlds_token= or a cookie automatically.
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
 * Initialize LaunchKit monitoring and return an instance for access gating.
 *
 *   const launchkit = init({ buildSlug: 'my-app' })
 *
 * All features start enabled by default. Remote config from the BWORLDS
 * dashboard can disable individual features. If the backend is unreachable,
 * everything stays on (fail-open).
 */
export function init(config: LaunchKitConfig): LaunchKitInstance {
  _buildSlug = config.buildSlug;
  _apiEndpoint = config.apiEndpoint ?? DEFAULT_API_ENDPOINT;
  _gateOrigin = config.gateOrigin ?? DEFAULT_GATE_ORIGIN;

  if (typeof window !== 'undefined') {
    const sandboxed = isSandboxed();

    configureSender({ buildSlug: _buildSlug, apiEndpoint: _apiEndpoint });

    // Start monitoring immediately (defaults: all on)
    startHeartbeat(_buildSlug);

    // Error capture and replay only run in top-level window.
    // Sandboxed iframes (e.g. Lovable/Bolt editor) are skipped.
    if (!sandboxed) {
      startErrorCapture(_buildSlug);
      startReplayModule(_buildSlug, _apiEndpoint);
    }

    // Remote config can disable features. Fail-open: if fetch fails, keep defaults.
    fetchRemoteConfig(_apiEndpoint, _buildSlug)
      .then((remote) => {
        if (!remote) return;
        if (!remote.monitoring) stopHeartbeat();
        if (!remote.sessionReplay) {
          stopErrorCapture();
          _stopReplay?.();
        }
      })
      .catch(() => {});

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

function startReplayModule(buildSlug: string, apiEndpoint: string): void {
  import('./replay')
    .then(({ startReplay, stopReplay }) => {
      _stopReplay = stopReplay;
      return startReplay(buildSlug, apiEndpoint);
    })
    .catch((err) => {
      console.warn('[@bworlds/launchkit] Session replay failed to start:', err);
    });
}

/**
 * Validate the current client's access token.
 * Standalone export -- works after init() has been called.
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
 * Standalone export -- works after init() has been called.
 */
export function getGateUrl(): string {
  if (!_buildSlug) {
    console.warn('[LaunchKit] getGateUrl() called before init().');
    return '';
  }
  return `${_gateOrigin}/access/${_buildSlug}`;
}

/**
 * Stop all monitoring.
 */
export function stop(): void {
  stopHeartbeat();
  stopErrorCapture();
  _stopReplay?.();
}
