import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startBadgeWidget, stopBadgeWidget } from '../src/badge-widget';

const TRUST_ORIGIN = 'https://app.example.com';

function badgeAnchor(): HTMLAnchorElement {
  const host = document.getElementById('bworlds-trust-badge') as HTMLDivElement;
  return host.shadowRoot?.querySelector('a.badge') as HTMLAnchorElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
});

afterEach(() => {
  stopBadgeWidget();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('badge_widget_mounts_on_flag', () => {
  it('mounts a host element with shadow DOM when started', () => {
    startBadgeWidget('my-app', TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge');
    expect(host).toBeTruthy();
    expect(host?.shadowRoot).toBeTruthy();
  });

  it('positions the host fixed at bottom-right with z-index 2147483000', () => {
    startBadgeWidget('my-app', TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge') as HTMLDivElement;
    expect(host.style.position).toBe('fixed');
    expect(host.style.bottom).toBe('16px');
    expect(host.style.right).toBe('24px');
    expect(host.style.zIndex).toBe('2147483000');
  });

  it('does not mount twice if called again while already mounted', () => {
    startBadgeWidget('my-app', TRUST_ORIGIN);
    startBadgeWidget('my-app', TRUST_ORIGIN);

    expect(document.querySelectorAll('#bworlds-trust-badge').length).toBe(1);
  });

  it('stopBadgeWidget removes the host element from the DOM', () => {
    startBadgeWidget('my-app', TRUST_ORIGIN);
    expect(document.getElementById('bworlds-trust-badge')).toBeTruthy();

    stopBadgeWidget();
    expect(document.getElementById('bworlds-trust-badge')).toBeNull();
  });
});

describe('badge_widget_renders_label_and_link', () => {
  it('ignores cached legacy counts and mounts without a network request', () => {
    sessionStorage.setItem('bworlds-badge-counts-acme', JSON.stringify({ passed: 7, total: 10 }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    startBadgeWidget('acme', TRUST_ORIGIN);

    expect(badgeAnchor().textContent).toBe('Runs on BWORLDS');
    expect(badgeAnchor().querySelector('.counts')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('links to the trust page on the trust origin with the encoded slug', () => {
    startBadgeWidget('acme app', TRUST_ORIGIN);

    expect(badgeAnchor().getAttribute('href')).toBe(`${TRUST_ORIGIN}/builds/acme%20app/trust`);
  });

  it('opens the trust page in a new tab with rel="noopener noreferrer"', () => {
    startBadgeWidget('acme', TRUST_ORIGIN);

    const anchor = badgeAnchor();
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor.getAttribute('aria-label')).toContain(anchor.textContent);
  });
});
