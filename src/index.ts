import { configureSender } from './telemetry-sender';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { startErrorCapture, stopErrorCapture } from './error-capture';
import { startNetworkCapture, stopNetworkCapture } from './network-capture';
import { startReplayTelemetry, stopReplayTelemetry } from './replay-telemetry';
import { check as _check } from './check';
import { fetchRemoteConfig, readCachedGatingEnabled } from './remote-config';
import { startBadgeWidget, stopBadgeWidget } from './badge-widget';
import { setIdentity, getIdentity } from './identity-state';
import { getReplaySessionId } from './session-state';
import {
  connectSupabase as _connectSupabase,
  startSupabaseIdentityBridge,
  stopSupabaseIdentityBridge,
  type SupabaseClientLike,
} from './supabase-identity-bridge';
import type { LaunchKitConfig } from './types';

export type { LaunchKitConfig } from './types';
export type { SupabaseClientLike } from './supabase-identity-bridge';
export type { CheckResult } from './check';

const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';
const DEFAULT_GATE_ORIGIN = 'https://app.bworlds.co';

// Module-level state set by init(), read by standalone check/getGateUrl.
let _buildSlug: string | null = null;
let _apiEndpoint = DEFAULT_API_ENDPOINT;
let _gateOrigin = DEFAULT_GATE_ORIGIN;

// Module-level ref for the dynamically-imported stopReplay function
let _stopReplay: (() => void) | null = null;

// Bumped on every replay activation and on stop(). The deferred ./replay import
// callback captures the value at activation and bails if it no longer matches, so
// a stop() issued during the import window cancels the pending start (_stopReplay
// is still null then, so stop() cannot reach the recorder directly).
let _replayActivation = 0;

// Guard against double init() — prevents duplicate subsystem activation
let _initialized = false;

// Identity state is injected into replay.ts so replay does not import its own
// copy when a CDN or bundler splits the SDK into multiple chunks.

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
  /**
   * Connect an existing Supabase browser client to BWORLDS session replay.
   * This reads only `session.user.email` and `session.user.id`.
   */
  connectSupabase: (client: SupabaseClientLike) => void;
}

/**
 * Strip the www. prefix from an origin so https://www.x.com matches https://x.com.
 */
function stripWww(origin: string): string {
  return origin.replace('://www.', '://');
}

/**
 * Check whether the current page's origin matches the build's allowed origin.
 * Returns true (activate) when:
 *   - `dev: true` is set (local development bypass)
 *   - `allowedOrigin` is null/empty (fail-open for backward compat)
 *   - origins match after www. normalization
 */
function originMatches(allowedOrigin: string | null, dev: boolean): boolean {
  if (dev) return true;
  if (!allowedOrigin) return true;
  if (typeof window === 'undefined') return true;
  return stripWww(window.location.origin) === stripWww(allowedOrigin);
}

/**
 * Initialize LaunchKit monitoring and return an instance for access gating.
 *
 *   const launchkit = init({ buildSlug: 'my-app' })
 *
 * All features start enabled by default. Remote config from the BWORLDS
 * dashboard can disable individual features. If the backend is unreachable,
 * everything stays on (fail-open).
 *
 * Origin guard: subsystems are deferred until after the sdk-config fetch
 * resolves. If the current page's origin doesn't match the build's registered
 * URL, no subsystems start — the SDK is completely silent.
 */
export function init(config: LaunchKitConfig): LaunchKitInstance {
  if (_initialized) {
    console.warn('[@bworlds/launchkit] init() called more than once — ignoring duplicate call.');
    return { check, getGateUrl, stop, identify, connectSupabase };
  }

  if (!config.buildSlug) {
    console.warn('[@bworlds/launchkit] init() called without buildSlug — SDK will not start.');
    return { check, getGateUrl, stop, identify, connectSupabase };
  }

  _initialized = true;

  _buildSlug = config.buildSlug;
  _apiEndpoint = config.apiEndpoint ?? DEFAULT_API_ENDPOINT;
  _gateOrigin = config.gateOrigin ?? DEFAULT_GATE_ORIGIN;

  if (typeof window !== 'undefined') {
    const sandboxed = isSandboxed();
    const isDev = config.dev === true;

    // configureSender is needed for the config fetch itself.
    configureSender({ buildSlug: _buildSlug, apiEndpoint: _apiEndpoint });

    // Fetch remote config, then check origin before activating any subsystem.
    // This replaces the previous eager-start approach.
    fetchRemoteConfig(_apiEndpoint, _buildSlug)
      .then((remote) => {
        try {
          if (!remote) {
            activateSubsystems(config, sandboxed, null);
            return;
          }

          const allowed = remote.allowedOrigin ?? null;
          if (!originMatches(allowed, isDev)) {
            return;
          }

          activateSubsystems(config, sandboxed, remote);
        } catch (err) {
          console.warn('[@bworlds/launchkit] subsystem activation failed:', err);
        }
      })
      .catch(() => {
        try {
          activateSubsystems(config, sandboxed, null);
        } catch (err) {
          console.warn('[@bworlds/launchkit] subsystem activation failed:', err);
        }
      });
  }

  return { check, getGateUrl, stop, identify, connectSupabase };
}

/**
 * Start all monitoring subsystems and gating logic.
 * Called only after origin check passes (or is bypassed).
 */
function activateSubsystems(
  config: LaunchKitConfig,
  sandboxed: boolean,
  remote: import('./remote-config').SdkRemoteConfig | null
): void {
  const buildSlug = _buildSlug!;
  const apiEndpoint = _apiEndpoint;

  // Start monitoring (defaults: all on).
  startHeartbeat(buildSlug);

  // Error capture and replay only run in top-level window.
  // Sandboxed iframes (e.g. Lovable/Bolt editor) are skipped.
  if (!sandboxed) {
    const isReplayEnabled = remote?.sessionReplay !== false;
    startErrorCapture(buildSlug);
    startNetworkCapture(apiEndpoint);
    startSupabaseIdentityBridge();
    if (isReplayEnabled) {
      // A remote toggle set to false is a kill switch: it forces the feature off
      // even when the host opted in locally. Both sides must allow it, defaulting
      // on when neither is set.
      startReplayModule(buildSlug, apiEndpoint, {
        activation: ++_replayActivation,
        enableReplayDiagnostics:
          (config.enableReplayDiagnostics ?? true) && (remote?.enableReplayDiagnostics ?? true),
        consoleTelemetry:
          (config.enableConsoleTelemetry ?? true) && (remote?.enableConsoleTelemetry ?? true),
        networkTelemetry:
          (config.enableNetworkTelemetry ?? true) && (remote?.enableNetworkTelemetry ?? true),
      });
    }
  }

  // Apply remote toggles if available.
  if (remote) {
    if (!remote.monitoring) stopHeartbeat();
    // Mirror the enable check (sessionReplay !== false): an unset value keeps
    // replay on, so only an explicit false tears it down. Using !sessionReplay
    // here would start replay above then immediately run this disabled path.
    if (remote.sessionReplay === false) {
      stopReplayTelemetry();
      stopErrorCapture();
      stopNetworkCapture();
      stopSupabaseIdentityBridge();
      _stopReplay?.();
    }
    if (remote.badge && !sandboxed) {
      void startBadgeWidget(buildSlug, apiEndpoint, _gateOrigin);
    }
  }

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
    const gatingEnabled = readCachedGatingEnabled(buildSlug);
    if (gatingEnabled) {
      const overlay = showGateOverlay();
      check()
        .then((session) => {
          if (!session.valid) {
            window.location.href = getGateUrl();
          } else {
            overlay.remove();
          }
        })
        .catch(() => {
          overlay.remove();
        });
    }
    // gatingEnabled === false: skip overlay and validate-token call entirely.
    // Background fetch already in flight to refresh the cache.
  }
}

function startReplayModule(
  buildSlug: string,
  apiEndpoint: string,
  options: {
    activation: number;
    enableReplayDiagnostics: boolean;
    consoleTelemetry: boolean;
    networkTelemetry: boolean;
  },
): void {
  import('./replay')
    .then(async ({ startReplay, stopReplay }) => {
      // stop() ran while ./replay was importing: abandon the start.
      if (options.activation !== _replayActivation) return;
      _stopReplay = stopReplay;
      await startReplay(buildSlug, apiEndpoint, {
        getIdentity,
        enableReplayDiagnostics: options.enableReplayDiagnostics,
        // When recording stops for any reason (including the internal 429
        // daily-cap stop) tear down the telemetry wrappers too.
        onStopped: stopReplayTelemetry,
      });
      // stop() ran while rrweb was starting: tear the recorder back down and skip
      // telemetry rather than leaving both running past the explicit stop.
      if (options.activation !== _replayActivation) {
        stopReplay();
        return;
      }
      // Console/network wrappers stamp captures with the active replay session.
      // Install them only once recording actually started: a failed rrweb load
      // clears the session id, and starting telemetry first would capture with a
      // null session and leave the wrappers installed until stop().
      if (getReplaySessionId() !== null) {
        startReplayTelemetry(buildSlug, apiEndpoint, {
          consoleTelemetry: options.consoleTelemetry,
          networkTelemetry: options.networkTelemetry,
        });
      }
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
  // Invalidate any replay activation still waiting on the ./replay import so it
  // does not start recording/telemetry after this stop.
  _replayActivation++;
  stopHeartbeat();
  stopReplayTelemetry();
  stopErrorCapture();
  stopNetworkCapture();
  stopSupabaseIdentityBridge();
  _stopReplay?.();
  stopBadgeWidget();
  _initialized = false;
}

/**
 * Forward end-user identity to BWORLDS session replay.
 * Call after init() when the user logs in or their identity is known.
 * Stored in shared module state; included in every subsequent chunk upload.
 */
export function identify(options: IdentifyOptions): void {
  setIdentity(options.email ?? null, options.userId ?? null);
}

/**
 * Connect an existing Supabase browser client to BWORLDS session replay.
 * This is optional: init() also attempts a best-effort localStorage bridge for
 * Lovable-style Supabase apps.
 */
export function connectSupabase(client: SupabaseClientLike): void {
  _connectSupabase(client);
}

/** Accessor for reading current identity state (re-exports from shared module). */
export const _getIdentity = getIdentity;
