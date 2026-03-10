/**
 * Inject toolbar styles into the document
 * This ensures styles work even when loaded via UMD script tag
 */

const STYLE_ID = 'bw-recorder-styles';

const CSS = `
.bw-recorder-toolbar {
  --bw-cream: #FAF7F2;
  --bw-cream-dim: #F0EBE0;
  --bw-charcoal: #1F1F23;
  --bw-coral: #E64C3C;
  --bw-coral-light: #EF6355;
  --bw-stone-200: #e7e5e4;
  --bw-stone-400: #a8a29e;
  --bw-stone-500: #78716c;
  position: fixed;
  z-index: 2147483647;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1;
  box-sizing: border-box;
}
.bw-recorder-toolbar * { box-sizing: border-box; }
.bw-recorder-toolbar.bottom-right { bottom: 16px; right: 16px; }
.bw-recorder-toolbar.bottom-left { bottom: 16px; left: 16px; }
.bw-recorder-toolbar.top-right { top: 16px; right: 16px; }
.bw-recorder-toolbar.top-left { top: 16px; left: 16px; }
.bw-toolbar-container {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--bw-cream);
  border: 1px solid var(--bw-stone-200);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.1);
}
.bw-toolbar-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 0 8px;
  border-right: 1px solid var(--bw-stone-200);
  min-width: 130px;
}
.bw-status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bw-stone-400);
  flex-shrink: 0;
}
.bw-status-indicator.recording {
  background: var(--bw-coral);
  animation: bw-pulse 1.5s ease-in-out infinite;
}
.bw-status-indicator.paused { background: var(--bw-stone-500); }
@keyframes bw-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@keyframes bw-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
.bw-spin {
  animation: bw-spin 1s linear infinite;
}
.bw-saving {
  color: var(--bw-stone-500);
}
.bw-status-text {
  color: var(--bw-charcoal);
  font-weight: 500;
  font-size: 12px;
}
.bw-status-time {
  color: var(--bw-stone-500);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  min-width: 40px;
}
.bw-toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--bw-charcoal);
  cursor: pointer;
  transition: all 0.15s ease;
  padding: 0;
}
.bw-toolbar-btn:hover { background: var(--bw-cream-dim); }
.bw-toolbar-btn:active { transform: translateY(1px); }
.bw-toolbar-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.bw-toolbar-btn:disabled:hover { background: transparent; }
.bw-toolbar-btn svg { width: 16px; height: 16px; }
.bw-toolbar-btn.primary { background: var(--bw-coral); color: white; }
.bw-toolbar-btn.primary:hover { background: var(--bw-coral-light); }
.bw-toolbar-btn.stop { color: var(--bw-coral); }
.bw-toolbar-btn.stop:hover { background: rgba(230, 76, 60, 0.1); }
.bw-toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--bw-stone-200);
  margin: 0 4px;
}
.bw-toolbar-logo {
  display: flex;
  align-items: center;
  padding: 0 8px 0 4px;
  color: var(--bw-stone-400);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: lowercase;
}
.bw-toolbar-idle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bw-cream);
  border: 1px solid var(--bw-stone-200);
  border-radius: 8px;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.1);
  cursor: pointer;
  transition: all 0.15s ease;
}
.bw-toolbar-idle:hover {
  background: var(--bw-cream-dim);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.1);
  transform: translateY(1px);
}
.bw-toolbar-idle .bw-idle-icon {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--bw-coral);
}
.bw-toolbar-idle .bw-idle-text {
  color: var(--bw-charcoal);
  font-weight: 500;
  font-size: 12px;
}
.bw-toolbar-idle .bw-idle-logo {
  color: var(--bw-stone-400);
  font-size: 10px;
  font-weight: 600;
  margin-left: 4px;
}
.bw-toolbar-complete {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bw-cream);
  border: 1px solid var(--bw-stone-200);
  border-radius: 8px;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.1);
}
.bw-toolbar-complete .bw-complete-icon { color: #2AA9A1; }
.bw-toolbar-complete .bw-complete-icon svg { width: 16px; height: 16px; }
.bw-toolbar-complete .bw-complete-text {
  color: var(--bw-charcoal);
  font-weight: 500;
  font-size: 12px;
}
.bw-toolbar-complete a {
  color: var(--bw-coral);
  text-decoration: none;
  font-weight: 500;
}
.bw-toolbar-complete a:hover { text-decoration: underline; }
.bw-restart-btn {
  margin-left: 8px;
  padding: 4px 10px;
  background: var(--bw-cream-dim);
  border: 1px solid var(--bw-stone-200);
  border-radius: 4px;
  color: var(--bw-charcoal);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.bw-restart-btn:hover {
  background: var(--bw-stone-200);
}
.bw-restart-btn:active {
  transform: translateY(1px);
}

/* Invite Dialog Styles */
.bw-invite-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: #1F1F23;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483646;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  box-sizing: border-box;
}
.bw-invite-overlay * { box-sizing: border-box; }
.bw-invite-dialog {
  background: white;
  border-radius: 12px;
  padding: 32px;
  width: 100%;
  max-width: 360px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  animation: bw-invite-fade-in 0.2s ease-out;
}
@keyframes bw-invite-fade-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
.bw-invite-logo {
  display: flex;
  justify-content: center;
  margin-bottom: 24px;
  color: var(--bw-coral, #E64C3C);
}
.bw-invite-logo svg {
  width: 40px;
  height: 40px;
}
.bw-invite-title {
  text-align: center;
  font-size: 24px;
  font-weight: 600;
  color: #1F1F23;
  margin: 0 0 8px 0;
}
.bw-invite-subtitle {
  text-align: center;
  font-size: 14px;
  color: #6b7280;
  margin: 0 0 24px 0;
  line-height: 1.5;
}
.bw-invite-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bw-invite-field {
  position: relative;
}
.bw-invite-input {
  width: 100%;
  padding: 12px 16px;
  font-size: 14px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: white;
  color: #1F1F23;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.bw-invite-input:focus {
  border-color: var(--bw-coral, #E64C3C);
  box-shadow: 0 0 0 3px rgba(230, 76, 60, 0.1);
}
.bw-invite-input[readonly] {
  background: #f9fafb;
  color: #6b7280;
  cursor: not-allowed;
}
.bw-invite-input::placeholder {
  color: #9ca3af;
}
.bw-invite-input[type="password"] {
  padding-right: 44px;
}
.bw-invite-input[type="text"]:not([readonly]) {
  padding-right: 44px;
}
.bw-invite-eye-btn {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: #9ca3af;
  border-radius: 4px;
  transition: color 0.15s ease;
}
.bw-invite-eye-btn:hover {
  color: #6b7280;
}
.bw-invite-eye-btn svg {
  width: 18px;
  height: 18px;
}
.bw-invite-submit {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 500;
  color: white;
  background: #10b981;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
  margin-top: 4px;
}
.bw-invite-submit:hover:not(:disabled) {
  background: #059669;
}
.bw-invite-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.bw-invite-submit svg {
  width: 16px;
  height: 16px;
}
@keyframes bw-invite-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.bw-invite-spin {
  animation: bw-invite-spin 1s linear infinite;
}
.bw-invite-login-text {
  text-align: center;
  font-size: 13px;
  color: #6b7280;
  margin: 20px 0 0 0;
}
.bw-invite-login-link {
  color: #10b981;
  text-decoration: none;
  font-weight: 500;
}
.bw-invite-login-link:hover {
  text-decoration: underline;
}
.bw-invite-success {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 0;
  animation: bw-invite-fade-in 0.3s ease-out;
}
.bw-invite-success-icon {
  color: #10b981;
  margin-bottom: 16px;
}
.bw-invite-success-icon svg {
  width: 48px;
  height: 48px;
}
.bw-invite-success-title {
  font-size: 20px;
  font-weight: 600;
  color: #1F1F23;
  margin: 0 0 4px 0;
}
.bw-invite-success-text {
  font-size: 14px;
  color: #6b7280;
  margin: 0;
}
`;

let stylesInjected = false;

export function injectStyles(): void {
  if (stylesInjected) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) {
    stylesInjected = true;
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  stylesInjected = true;
}

export function removeStyles(): void {
  const style = document.getElementById(STYLE_ID);
  if (style) {
    style.remove();
    stylesInjected = false;
  }
}
