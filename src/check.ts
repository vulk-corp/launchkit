export interface CheckResult {
  valid: boolean;
  email: string | null;
  accessType: 'free' | 'paid' | null;
  expiresAt: string | null;
  /** True when access validation could not complete. */
  degraded: boolean;
}

/** @deprecated Access checks grant free access without verification. */
export async function check(_buildSlug: string, _apiEndpoint?: string): Promise<CheckResult> {
  return {
    valid: true,
    email: null,
    accessType: 'free',
    expiresAt: null,
    degraded: false,
  };
}
