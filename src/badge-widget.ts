/**
 * Trust badge: floating "Runs on BWORLDS" pill mounted in shadow DOM.
 * Counts are tab-cached via sessionStorage; CDN caches the endpoint.
 */

import { fetchJsonWithTimeout } from './fetch-util';

interface BadgeCounts {
  passed: number;
  total: number;
}

let _host: HTMLDivElement | null = null;

const Z_INDEX = 2147483000;

// Mirrored from apps/bworlds-web/src/app/globals.css.
const COLOR_ICON = '#e64c3c';
const COLOR_LABEL = '#1f1f23';
const COLOR_COUNTS = '#2aa9a1';
const COLOR_BORDER = '#e7e5e4';

function cacheKey(buildSlug: string): string {
  return `bworlds-badge-counts-${buildSlug}`;
}

function readCache(buildSlug: string): BadgeCounts | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(buildSlug));
    if (!raw) return null;
    return JSON.parse(raw) as BadgeCounts;
  } catch {
    return null;
  }
}

function writeCache(buildSlug: string, counts: BadgeCounts): void {
  try {
    sessionStorage.setItem(cacheKey(buildSlug), JSON.stringify(counts));
  } catch {
    // sessionStorage unavailable — skip cache write, not fatal
  }
}

export async function startBadgeWidget(
  buildSlug: string,
  apiEndpoint: string,
  trustOrigin: string
): Promise<void> {
  if (typeof document === 'undefined') return;
  if (_host) return;

  const counts = await fetchBadgeCounts(apiEndpoint, buildSlug);
  mount(buildSlug, trustOrigin, counts);
}

export function stopBadgeWidget(): void {
  if (_host) {
    _host.remove();
    _host = null;
  }
}

async function fetchBadgeCounts(
  apiEndpoint: string,
  buildSlug: string
): Promise<BadgeCounts | null> {
  const cached = readCache(buildSlug);
  if (cached) return cached;

  const counts = await fetchJsonWithTimeout<BadgeCounts>(
    `${apiEndpoint}/api/telemetry/badge-counts?buildSlug=${encodeURIComponent(buildSlug)}`
  );
  if (!counts || typeof counts.passed !== 'number' || typeof counts.total !== 'number') {
    return null;
  }
  writeCache(buildSlug, counts);
  return counts;
}

function mount(buildSlug: string, trustOrigin: string, counts: BadgeCounts | null): void {
  if (!document.body) return;

  const host = document.createElement('div');
  host.id = 'bworlds-trust-badge';
  Object.assign(host.style, {
    position: 'fixed',
    bottom: '16px',
    right: '24px',
    zIndex: String(Z_INDEX),
  } as CSSStyleDeclaration);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host, * { box-sizing: border-box; }
    a.badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-radius: 8px;
      background: #ffffff;
      border: 1px solid ${COLOR_BORDER};
      box-shadow: 0 4px 0 rgba(0, 0, 0, 0.08);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      text-decoration: none;
      cursor: pointer;
      transition: transform 200ms ease, box-shadow 200ms ease;
    }
    a.badge:hover {
      transform: translateY(2px);
      box-shadow: 0 2px 0 rgba(0, 0, 0, 0.06);
    }
    .icon { color: ${COLOR_ICON}; flex-shrink: 0; }
    .label {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.025em;
      color: ${COLOR_LABEL};
      line-height: 1;
    }
    .counts {
      font-size: 12px;
      font-weight: 700;
      color: ${COLOR_COUNTS};
      line-height: 1;
    }
  `;
  shadow.appendChild(style);

  const anchor = document.createElement('a');
  anchor.className = 'badge';
  // Use setAttribute so browser URL-escapes the slug; trustOrigin is SDK config (trusted).
  anchor.setAttribute('href', `${trustOrigin}/builds/${encodeURIComponent(buildSlug)}/trust`);
  anchor.setAttribute('target', '_blank');
  anchor.setAttribute('rel', 'noopener noreferrer');
  anchor.setAttribute('aria-label', 'View trust page for this app on BWORLDS');

  // Hammer icon — lucide-react source, 24px viewBox, 2px stroke.
  anchor.appendChild(buildHammerIcon());

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Runs on BWORLDS';
  anchor.appendChild(label);

  if (counts && counts.total > 0) {
    const countsEl = document.createElement('span');
    countsEl.className = 'counts';
    countsEl.textContent = `${counts.passed}/${counts.total}`;
    anchor.appendChild(countsEl);
  }

  shadow.appendChild(anchor);

  document.body.appendChild(host);
  _host = host;
}

function buildHammerIcon(): SVGSVGElement {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('xmlns', svgNs);
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');

  const paths = [
    'm15 12-8.5 8.5c-.83.83-2.17.83-3 0 0 0 0 0 0 0a2.12 2.12 0 0 1 0-3L12 9',
    'M17.64 15 22 10.64',
    'm20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91',
  ];
  for (const d of paths) {
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
