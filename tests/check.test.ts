import { check } from '../src/check';

const mockFetch = vi.fn();
const mockReplaceState = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockClear();
  mockReplaceState.mockClear();
  // Reset location and cookies
  Object.defineProperty(window, 'location', {
    value: new URL('http://localhost/'),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'history', {
    value: { replaceState: mockReplaceState, state: null },
    writable: true,
    configurable: true,
  });
  document.cookie = 'bworlds_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockResponse(status: number, body?: Record<string, unknown>) {
  return new Response(body ? JSON.stringify(body) : null, { status });
}

describe('check()', () => {
  it('reads token from URL query param', async () => {
    Object.defineProperty(window, 'location', {
      value: new URL('http://localhost/?bworlds_token=url-token'),
      writable: true,
      configurable: true,
    });
    mockFetch.mockResolvedValueOnce(mockResponse(200, { access_type: 'free', expires_at: '2026-12-31' }));

    await check('test-app');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.token).toBe('url-token');
    expect(body.build_slug).toBe('test-app');
  });

  it('reads token from cookie when no URL param', async () => {
    document.cookie = 'bworlds_token=cookie-token';
    mockFetch.mockResolvedValueOnce(mockResponse(200, { access_type: 'paid', expires_at: '2026-12-31' }));

    await check('test-app');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.token).toBe('cookie-token');
  });

  it('sends empty string when no token found', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { access_type: 'free', expires_at: '2026-12-31' }));

    await check('test-app');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.token).toBe('');
  });

  it('returns valid result on 200', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { access_type: 'paid', expires_at: '2026-12-31' }));

    const result = await check('test-app');

    expect(result).toEqual({
      valid: true,
      email: null,
      accessType: 'paid',
      expiresAt: '2026-12-31',
      degraded: false,
    });
  });

  it('returns fail-closed on 401', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(401));

    const result = await check('test-app');

    expect(result).toEqual({
      valid: false,
      email: null,
      accessType: null,
      expiresAt: null,
      degraded: false,
    });
  });

  it('returns fail-closed on 403', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(403));

    const result = await check('test-app');

    expect(result.valid).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it('returns fail-open on 500 (degraded)', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(500));

    const result = await check('test-app');

    expect(result).toEqual({
      valid: true,
      email: null,
      accessType: null,
      expiresAt: null,
      degraded: true,
    });
  });

  it('returns fail-open on network error (degraded)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await check('test-app');

    expect(result).toEqual({
      valid: true,
      email: null,
      accessType: null,
      expiresAt: null,
      degraded: true,
    });
  });

  it('uses custom apiEndpoint', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { access_type: 'free', expires_at: '2026-12-31' }));

    await check('test-app', 'https://custom.api');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://custom.api/api/monetization/validate-token');
  });

  it('persists token in cookie after successful validation', async () => {
    Object.defineProperty(window, 'location', {
      value: new URL('http://localhost/?bworlds_token=jwt-from-url'),
      writable: true,
      configurable: true,
    });
    mockFetch.mockResolvedValueOnce(mockResponse(200, { access_type: 'paid', expires_at: '2026-12-31T00:00:00Z' }));

    await check('test-app');

    expect(document.cookie).toContain('bworlds_token=jwt-from-url');
  });

  it('strips bworlds_token from URL after successful validation', async () => {
    Object.defineProperty(window, 'location', {
      value: new URL('http://localhost/page?bworlds_token=jwt-from-url&other=keep'),
      writable: true,
      configurable: true,
    });
    mockFetch.mockResolvedValueOnce(mockResponse(200, { access_type: 'free', expires_at: '2026-12-31' }));

    await check('test-app');

    expect(mockReplaceState).toHaveBeenCalledOnce();
    const newUrl = mockReplaceState.mock.calls[0][2] as string;
    expect(newUrl).not.toContain('bworlds_token');
    expect(newUrl).toContain('other=keep');
  });

  it('does not strip URL when token came from cookie', async () => {
    document.cookie = 'bworlds_token=cookie-token';
    mockFetch.mockResolvedValueOnce(mockResponse(200, { access_type: 'paid', expires_at: '2026-12-31' }));

    await check('test-app');

    expect(mockReplaceState).not.toHaveBeenCalled();
  });

  it('clears cookie on 401', async () => {
    document.cookie = 'bworlds_token=stale-token';
    mockFetch.mockResolvedValueOnce(mockResponse(401));

    await check('test-app');

    // After clearing, the cookie value should be empty/gone
    expect(document.cookie).not.toContain('stale-token');
  });

  it('does not persist token on 5xx (degraded)', async () => {
    Object.defineProperty(window, 'location', {
      value: new URL('http://localhost/?bworlds_token=jwt-from-url'),
      writable: true,
      configurable: true,
    });
    mockFetch.mockResolvedValueOnce(mockResponse(500));

    await check('test-app');

    expect(document.cookie).not.toContain('jwt-from-url');
  });
});
