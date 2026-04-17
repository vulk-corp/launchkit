import { startBadgeWidget, stopBadgeWidget } from '../src/badge-widget';

const API_ENDPOINT = 'https://api.example.com';
const TRUST_ORIGIN = 'https://app.example.com';

function mockFetchJson(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
});

afterEach(() => {
  stopBadgeWidget();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('badge_widget_mounts_on_flag', () => {
  it('mounts a host element with shadow DOM when started', async () => {
    mockFetchJson({ passed: 5, total: 10 });

    await startBadgeWidget('my-app', API_ENDPOINT, TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge');
    expect(host).toBeTruthy();
    expect(host?.shadowRoot).toBeTruthy();
  });

  it('positions the host fixed at bottom-right with z-index 2147483000', async () => {
    mockFetchJson({ passed: 5, total: 10 });

    await startBadgeWidget('my-app', API_ENDPOINT, TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge') as HTMLDivElement;
    expect(host.style.position).toBe('fixed');
    expect(host.style.bottom).toBe('16px');
    expect(host.style.right).toBe('24px');
    expect(host.style.zIndex).toBe('2147483000');
  });

  it('does not mount twice if called again while already mounted', async () => {
    const fetchMock = mockFetchJson({ passed: 5, total: 10 });

    await startBadgeWidget('my-app', API_ENDPOINT, TRUST_ORIGIN);
    await startBadgeWidget('my-app', API_ENDPOINT, TRUST_ORIGIN);

    const hosts = document.querySelectorAll('#bworlds-trust-badge');
    expect(hosts.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stopBadgeWidget removes the host element from the DOM', async () => {
    mockFetchJson({ passed: 5, total: 10 });

    await startBadgeWidget('my-app', API_ENDPOINT, TRUST_ORIGIN);
    expect(document.getElementById('bworlds-trust-badge')).toBeTruthy();

    stopBadgeWidget();
    expect(document.getElementById('bworlds-trust-badge')).toBeNull();
  });

  it('falls back to label-only markup when the counts endpoint fails', async () => {
    mockFetchJson({}, /* ok */ false);

    await startBadgeWidget('my-app', API_ENDPOINT, TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge') as HTMLDivElement;
    const anchor = host.shadowRoot?.querySelector('a.badge') as HTMLAnchorElement;
    expect(anchor).toBeTruthy();
    expect(anchor.textContent).toContain('Runs on');
    expect(anchor.textContent).toContain('BWORLDS');
    expect(host.shadowRoot?.querySelector('.counts')).toBeFalsy();
  });

  it('falls back to label-only when fetch rejects (network error or timeout)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down'))
    );

    await startBadgeWidget('my-app', API_ENDPOINT, TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge') as HTMLDivElement;
    expect(host.shadowRoot?.querySelector('.counts')).toBeFalsy();
  });
});

describe('badge_widget_renders_counts_and_link', () => {
  it('renders the {passed}/{total} counts text when the endpoint returns them', async () => {
    mockFetchJson({ passed: 7, total: 10 });

    await startBadgeWidget('acme', API_ENDPOINT, TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge') as HTMLDivElement;
    const counts = host.shadowRoot?.querySelector('.counts') as HTMLElement;
    expect(counts).toBeTruthy();
    expect(counts.textContent).toBe('7/10');
  });

  it('links to the trust page on the trust origin with correct slug', async () => {
    mockFetchJson({ passed: 3, total: 3 });

    await startBadgeWidget('acme', API_ENDPOINT, TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge') as HTMLDivElement;
    const anchor = host.shadowRoot?.querySelector('a.badge') as HTMLAnchorElement;
    expect(anchor.getAttribute('href')).toBe(`${TRUST_ORIGIN}/builds/acme/trust`);
  });

  it('opens the trust page in a new tab with rel="noopener noreferrer"', async () => {
    mockFetchJson({ passed: 3, total: 3 });

    await startBadgeWidget('acme', API_ENDPOINT, TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge') as HTMLDivElement;
    const anchor = host.shadowRoot?.querySelector('a.badge') as HTMLAnchorElement;
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('omits the counts suffix when total === 0 (no scan yet)', async () => {
    mockFetchJson({ passed: 0, total: 0 });

    await startBadgeWidget('acme', API_ENDPOINT, TRUST_ORIGIN);

    const host = document.getElementById('bworlds-trust-badge') as HTMLDivElement;
    const anchor = host.shadowRoot?.querySelector('a.badge') as HTMLAnchorElement;
    expect(anchor.textContent).toContain('Runs on');
    expect(host.shadowRoot?.querySelector('.counts')).toBeFalsy();
  });

  it('calls the /api/telemetry/badge-counts endpoint with the encoded slug', async () => {
    const fetchMock = mockFetchJson({ passed: 5, total: 10 });

    await startBadgeWidget('acme app', API_ENDPOINT, TRUST_ORIGIN);

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_ENDPOINT}/api/telemetry/badge-counts?buildSlug=acme%20app`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});
