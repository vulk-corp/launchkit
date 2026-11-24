import { configureSender } from './telemetry-sender';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { startErrorCapture, stopErrorCapture } from './error-capture';
import { startNetworkCapture, stopNetworkCapture } from './network-capture';
import { startReplayTelemetry, stopReplayTelemetry } from './replay-telemetry';
import { check as checkAccess } from './check';
import { fetchRemoteConfig } from './remote-config';
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
export type { CheckResult } from './check';
export type { SupabaseClientLike } from './supabase-identity-bridge';
export { abortExpectedRequest, type ExpectedCancellationReason } from './cancellation';

const DEFAULT_API_ENDPOINT = 'https://api.bworlds.co';
const DEFAULT_WEB_ORIGIN = 'https://app.bworlds.co';

let _buildSlug: string | null = null;
let _apiEndpoint = DEFAULT_API_ENDPOINT;
let _gateOrigin = DEFAULT_WEB_ORIGIN;

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

export interface IdentifyOptions {
  /** End-user email address. Sent with each subsequent chunk as `userEmail`. */
  email?: string;
  /** End-user identifier from your system. Sent with each chunk as `userId`. */
  userId?: string;
}

export interface LaunchKitInstance {
  /** @deprecated Access checks grant free access without verification. */
  check: () => ReturnType<typeof checkAccess>;
  /** @deprecated The hosted access route is unavailable. */
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
 * Initialize LaunchKit monitoring.
 *
 *   const launchkit = init({ buildSlug: 'my-app' })
 *
 * Heartbeat and error capture start enabled by default. Session replay starts
 * only when remote config explicitly enables it.
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
  _apiEndpoint = (config.apiEndpoint ?? DEFAULT_API_ENDPOINT).replace(/\/+$/, '');
  _gateOrigin = (config.gateOrigin ?? DEFAULT_WEB_ORIGIN).replace(/\/+$/, '');

  if (typeof window !== 'undefined') {
    const sandboxed = isSandboxed();
    const isDev = config.dev === true;

    // configureSender is needed for the config fetch itself.
    configureSender({ buildSlug: _buildSlug, apiEndpoint: _apiEndpoint });

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

function activateSubsystems(
  config: LaunchKitConfig,
  sandboxed: boolean,
  remote: import('./remote-config').SdkRemoteConfig | null
): void {
  const buildSlug = _buildSlug!;
  const apiEndpoint = _apiEndpoint;

  const errorCaptureEnabled = remote
    ? (remote.errorCapture ?? remote.sessionReplay) !== false
    : true;
  const sessionReplayEnabled = remote?.sessionReplay === true;

  startHeartbeat(buildSlug);

  // Error capture and replay only run in top-level window.
  // Sandboxed iframes (e.g. Lovable/Bolt editor) are skipped.
  if (!sandboxed) {
    if (errorCaptureEnabled) {
      startErrorCapture(buildSlug);
      startNetworkCapture(apiEndpoint);
    }
    if (sessionReplayEnabled) {
      startSupabaseIdentityBridge();
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
    if (remote.badge && !sandboxed) {
      try {
        startBadgeWidget(buildSlug, _gateOrigin);
      } catch (err) {
        console.warn('[@bworlds/launchkit] trust badge failed to mount:', err);
      }
    }
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

/** @deprecated Access checks grant free access without verification. */
export function check(): ReturnType<typeof checkAccess> {
  if (!_buildSlug) {
    return Promise.resolve({
      valid: true,
      email: null,
      accessType: null,
      expiresAt: null,
      degraded: true,
    });
  }
  return checkAccess(_buildSlug, _apiEndpoint);
}

/** @deprecated The hosted access route is unavailable. */
export function getGateUrl(): string {
  return _buildSlug ? `${_gateOrigin}/access/${_buildSlug}` : '';
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
