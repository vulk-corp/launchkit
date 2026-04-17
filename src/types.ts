/**
 * Configuration for LaunchKit monitoring.
 * Feature toggles (heartbeat, error capture, session replay) are managed
 * remotely from the BWORLDS dashboard. If the backend is unreachable,
 * all features default to enabled.
 */
export interface LaunchKitConfig {
  /** Your build slug from the BWORLDS dashboard */
  buildSlug: string;
  /** API endpoint (defaults to https://api.bworlds.co) */
  apiEndpoint?: string;
  /** Enable access gating (default: true). Validates visitor tokens
   *  and redirects unauthorized visitors to the BWORLDS access page. */
  gate?: boolean;
  /** Origin of the BWORLDS access page used for gate redirects.
   *  Defaults to https://app.bworlds.co. Set this to point the
   *  /access/:slug redirect at a local BWORLDS web instance during
   *  development. No trailing slash. */
  gateOrigin?: string;
}
