import { render } from 'preact';
import { useState } from 'preact/hooks';
import { injectStyles } from './injectStyles';

type InviteDialogState = 'form' | 'loading' | 'success';

interface InviteDialogProps {
  email: string;
  onComplete: () => void;
  onLogin: () => void;
}

const STORAGE_KEY = 'bw_invite_completed';

// Bworlds logo (hammer icon)
const BwLogo = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="32"
    height="32"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" />
    <path d="m18 15 4-4" />
    <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />
  </svg>
);

// Eye icon for password visibility toggle
const EyeIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

// Eye off icon
const EyeOffIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

// Check icon for success state
const CheckCircleIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

// Loader icon
const LoaderIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    class="bw-invite-spin"
  >
    <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07l-2.83 2.83M9.76 14.24l-2.83 2.83m11.14 0l-2.83-2.83M9.76 9.76L6.93 6.93" />
  </svg>
);

function InviteDialog({ email, onComplete, onLogin }: InviteDialogProps) {
  const [state, setState] = useState<InviteDialogState>('form');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!password.trim()) return;

    setState('loading');

    // Fake loading delay
    setTimeout(() => {
      setState('success');

      // Save to localStorage
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ email, timestamp: Date.now() })
      );

      // Auto-close after success animation
      setTimeout(() => {
        onComplete();
      }, 1500);
    }, 1200);
  };

  const handleLogin = (e: Event) => {
    e.preventDefault();
    // Save to localStorage so dialog doesn't show again
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ email, timestamp: Date.now() })
    );
    onLogin();
  };

  return (
    <div class="bw-invite-overlay" data-bw-launchkit-ui>
      <div class="bw-invite-dialog">
        {state === 'success' ? (
          <div class="bw-invite-success">
            <div class="bw-invite-success-icon">
              <CheckCircleIcon />
            </div>
            <h2 class="bw-invite-success-title">You're in!</h2>
            <p class="bw-invite-success-text">Welcome aboard.</p>
          </div>
        ) : (
          <>
            <div class="bw-invite-logo">
              <BwLogo />
            </div>

            <h2 class="bw-invite-title">Welcome</h2>
            <p class="bw-invite-subtitle">
              You've been invited. Set a password to continue.
            </p>

            <form class="bw-invite-form" onSubmit={handleSubmit}>
              <div class="bw-invite-field">
                <input
                  type="email"
                  value={email}
                  readonly
                  class="bw-invite-input"
                  placeholder="Email address"
                />
              </div>

              <div class="bw-invite-field">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onInput={(e) =>
                    setPassword((e.target as HTMLInputElement).value)
                  }
                  class="bw-invite-input"
                  placeholder="Password"
                  disabled={state === 'loading'}
                  autoFocus
                />
                <button
                  type="button"
                  class="bw-invite-eye-btn"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>

              <button
                type="submit"
                class="bw-invite-submit"
                disabled={state === 'loading' || !password.trim()}
              >
                {state === 'loading' ? (
                  <>
                    <LoaderIcon />
                    <span>Setting up...</span>
                  </>
                ) : (
                  'Continue'
                )}
              </button>
            </form>

            <p class="bw-invite-login-text">
              Already have an account?{' '}
              <a href="#" onClick={handleLogin} class="bw-invite-login-link">
                Log in
              </a>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Controller for managing the InviteDialog lifecycle
 */
export class InviteDialogController {
  private container: HTMLDivElement | null = null;
  private email: string;
  private onCompleteCallback: (() => void) | null = null;

  constructor(email: string) {
    this.email = email;
  }

  /**
   * Check if invite has already been completed
   */
  static isCompleted(): boolean {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) !== null;
  }

  /**
   * Clear completion state (for testing)
   */
  static clearCompletion(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
  }

  /**
   * Mount the dialog to the DOM
   */
  mount(): void {
    if (this.container) return;

    // Inject styles first
    injectStyles();

    this.container = document.createElement('div');
    this.container.id = 'bw-invite-root';
    this.container.setAttribute('data-bw-launchkit-ui', '');
    document.body.appendChild(this.container);

    this.render();
  }

  /**
   * Unmount the dialog from the DOM
   */
  unmount(): void {
    if (this.container) {
      render(null, this.container);
      this.container.remove();
      this.container = null;
    }
  }

  /**
   * Set completion callback
   */
  onComplete(callback: () => void): void {
    this.onCompleteCallback = callback;
  }

  /**
   * Handle dialog completion
   */
  private handleComplete = (): void => {
    this.unmount();
    this.onCompleteCallback?.();
  };

  /**
   * Handle login click (closes dialog)
   */
  private handleLogin = (): void => {
    this.unmount();
    this.onCompleteCallback?.();
  };

  /**
   * Render the dialog
   */
  private render(): void {
    if (!this.container) return;

    render(
      <InviteDialog
        email={this.email}
        onComplete={this.handleComplete}
        onLogin={this.handleLogin}
      />,
      this.container
    );
  }
}
