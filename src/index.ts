import { configureSender } from './telemetry-sender';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { startErrorCapture, stopErrorCapture } from './error-capture';
import { check as _check } from './check';
import { fetchRemoteConfig, readCachedGatingEnabled } from './remote-config';
import { startBadgeWidget, stopBadgeWidget } from './badge-widget';
import { setIdentity, getIdentity } from './identity-state';
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

// (Identity state lives in identity-state.ts to avoid circular imports with replay.ts)

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

export interface IdentifyOptions {
  /** End-user email address. Sent with each subsequent chunk as `userEmail`. */
  email?: string;
  /** End-user identifier from your system. Sent with each chunk as `userId`. */
  userId?: string;
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
  /**
   * Forward end-user identity to BWORLDS session replay.
   * Call after init() when the user logs in or their identity is known.
   * Identity is included in every subsequent chunk upload.
   */
  identify: (options: IdentifyOptions) => void;
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
    // Trust badge is opt-in (default off), mounted only when remote.badge === true.
    fetchRemoteConfig(_apiEndpoint, _buildSlug)
      .then((remote) => {
        if (!remote) return;
        if (!remote.monitoring) stopHeartbeat();
        if (!remote.sessionReplay) {
          stopErrorCapture();
          _stopReplay?.();
        }
        if (remote.badge && !sandboxed && _buildSlug) {
          void startBadgeWidget(_buildSlug, _apiEndpoint, _gateOrigin);
        }
      })
      .catch(() => {});

    // Access gating: show loading screen, check token, redirect or reveal app.
    // Skipped in sandboxed iframes (editor previews).
    //
    // SWR cache check (synchronous): if the cached config explicitly says
    // gatingEnabled=false, this build has no paid pricing — skip the overlay
    // AND the validate-token call entirely. The background fetch (already kicked
    // off by fetchRemoteConfig above) will overwrite the cache with fresh data.
    //
    // Fail-safe: on cold cache / parse error / missing field → gating defaults true
    // → overlay mounts (paid content never exposed by a silent failure).
    if (config.gate !== false && !sandboxed) {
      const gatingEnabled = readCachedGatingEnabled(_buildSlug!);
      if (gatingEnabled) {
        const overlay = showGateOverlay();
        check().then((session) => {
          if (!session.valid) {
            window.location.href = getGateUrl();
          } else {
            overlay.remove();
          }
        });
      }
      // gatingEnabled === false: skip overlay and validate-token call entirely.
      // Background fetch already in flight to refresh the cache.
    }
  }

  return { check, getGateUrl, stop, identify };
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
  stopBadgeWidget();
}

/**
 * Forward end-user identity to BWORLDS session replay.
 * Call after init() when the user logs in or their identity is known.
 * Stored in shared module state; included in every subsequent chunk upload.
 */
export function identify(options: IdentifyOptions): void {
  setIdentity(options.email ?? null, options.userId ?? null);
}

/** Accessor for reading current identity state (re-exports from shared module). */
export const _getIdentity = getIdentity;
