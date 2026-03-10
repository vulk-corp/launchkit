/**
 * Privacy utilities for masking sensitive inputs
 */

// Selectors for elements that should always be masked
const SENSITIVE_SELECTORS = [
  'input[type="password"]',
  'input[type="credit-card"]',
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-csc"]',
  'input[autocomplete="cc-exp"]',
  'input[autocomplete="cc-exp-month"]',
  'input[autocomplete="cc-exp-year"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="current-password"]',
  'input[name*="password"]',
  'input[name*="passwd"]',
  'input[name*="secret"]',
  'input[name*="token"]',
  'input[name*="apikey"]',
  'input[name*="api_key"]',
  'input[name*="api-key"]',
  'input[name*="credit"]',
  'input[name*="card"]',
  'input[name*="cvv"]',
  'input[name*="cvc"]',
  'input[name*="ssn"]',
  'input[id*="password"]',
  'input[id*="secret"]',
  'input[id*="token"]',
  '[data-private]',
  '[data-mask]',
  '[data-sensitive]',
];

/**
 * Get the CSS selector string for masking
 */
export function getMaskSelector(): string {
  return SENSITIVE_SELECTORS.join(', ');
}

/**
 * Get rrweb maskTextSelector for privacy
 */
export function getMaskTextSelector(): string {
  return '[data-private-text], [data-mask-text]';
}

/**
 * Check if an element should be masked
 */
export function shouldMaskElement(element: Element): boolean {
  return element.matches(getMaskSelector());
}

/**
 * Get rrweb privacy configuration
 */
export function getPrivacyConfig(enabled: boolean) {
  if (!enabled) {
    return {
      maskAllInputs: false,
      maskTextSelector: null,
      maskInputOptions: {},
    };
  }

  return {
    maskAllInputs: false, // We use selective masking
    maskTextSelector: getMaskTextSelector(),
    maskInputOptions: {
      password: true,
      // Mask inputs matching our sensitive selectors
    },
    // Custom mask function for input values
    maskInputFn: (text: string, element: HTMLElement): string => {
      if (shouldMaskElement(element)) {
        return '*'.repeat(Math.min(text.length, 20));
      }
      return text;
    },
    // Block specific elements from being recorded (including our own UI)
    blockSelector: '[data-recorder-block], [data-bw-recorder-ui], #bw-recorder-root',
    // Ignore specific elements
    ignoreSelector: '[data-recorder-ignore]',
  };
}

/**
 * Mask a text value
 */
export function maskText(text: string, maskChar = '*'): string {
  return maskChar.repeat(Math.min(text.length, 20));
}
