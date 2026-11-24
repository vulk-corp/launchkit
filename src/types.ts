/**
 * Configuration for LaunchKit monitoring.
 * Feature toggles for error capture and session replay are managed remotely
 * from the BWORLDS dashboard. If the backend is unreachable, error capture
 * defaults to enabled and session replay stays disabled.
 */
export interface LaunchKitConfig {
  /** Your build slug from the BWORLDS dashboard */
  buildSlug: string;
  /** API endpoint (defaults to https://api.bworlds.co) */
  apiEndpoint?: string;
  /** @deprecated Access gating is disabled. This option has no effect. */
  gate?: boolean;
  /** Origin for the public Trust Page badge. Defaults to https://app.bworlds.co. */
  gateOrigin?: string;
  /** Bypass origin-scope guard for local development.
   *  When true, all subsystems activate regardless of origin mismatch.
   *  Do not ship with `dev: true` in production. */
  dev?: boolean;
  /** Emit replay lifecycle diagnostics. Defaults to true when replay is enabled. */
  enableReplayDiagnostics?: boolean;
  /** Capture console timeline telemetry. Defaults to true when replay is enabled. */
  enableConsoleTelemetry?: boolean;
  /** Capture fetch/XHR timeline telemetry. Defaults to true when replay is enabled. */
  enableNetworkTelemetry?: boolean;
}
