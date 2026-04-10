/**
 * Configuration for LaunchKit monitoring.
 */
export interface LaunchKitConfig {
  /** Your build slug from the BWORLDS dashboard */
  buildSlug: string;
  /** API endpoint (defaults to https://api.bworlds.co) */
  apiEndpoint?: string;
  /** Heartbeat interval in ms (default: 5 minutes) */
  heartbeatInterval?: number;
  /** Enable error capture (default: true) */
  enableErrorCapture?: boolean;
  /** Enable heartbeat (default: true) */
  enableHeartbeat?: boolean;
  /** Enable access gating (default: true). Validates visitor tokens
   *  and redirects unauthorized visitors to the BWORLDS access page. */
  gate?: boolean;
}
