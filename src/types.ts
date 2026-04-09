/**
 * Configuration for LaunchKit monitoring.
 * Feature toggles are managed remotely from the BWORLDS dashboard.
 * If the backend is unreachable, all features default to enabled.
 */
export interface LaunchKitConfig {
  /** Your build slug from the BWORLDS dashboard */
  buildSlug: string;
  /** API endpoint (defaults to https://api.bworlds.co) */
  apiEndpoint?: string;
}
