import { getReplaySessionId } from './session-state';
import { sendTelemetry } from './telemetry-sender';
import { MAX_MESSAGE_LENGTH, MAX_URL_LENGTH, normalizeThrown, sanitizeAndTruncate } from './normalize-thrown';

declare const __SDK_VERSION__: string;

const TELEMETRY_PATH = '/api/telemetry/replay-telemetry';
const BATCH_INTERVAL_MS = 10_000;
const BATCH_SIZE_THRESHOLD = 10;
const MAX_EVENTS_PER_MINUTE = 120;
const MAX_ARG_DEPTH = 3;
const MAX_SERIALIZED_ARG_LENGTH = 500;
const MAX_METHOD_LENGTH = 32;
// The SDK's own console output is prefixed with this tag; capturing it as host
// telemetry would echo the SDK's warnings back through the pipeline and burn the
// per-minute rate-limit budget meant for genuine host logs.
const SDK_LOG_PREFIX = '[@bworlds/launchkit]';
const REDACTED = '[REDACTED]';
// Words that mark a query parameter or header as carrying a credential. Matched
// against camelCase / snake_case / kebab-case segments so accessToken,
// access_token, and x-access-token all redact, not only dash/underscore-bounded
// forms — the previous single boundary regex leaked camelCase secrets.
const SENSITIVE_KEY_WORDS = new Set([
  'token',
  'access',
  'refresh',
  'auth',
  'authorization',
  'authentication',
  'password',
  'passwd',
  'secret',
  'key',
  'apikey',
  'jwt',
  'session',
  'cookie',
]);

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
type ReplayTelemetryType = 'console' | 'network';
type NetworkInitiator = 'fetch' | 'xmlhttprequest';

interface StartReplayTelemetryOptions {
  consoleTelemetry?: boolean;
  networkTelemetry?: boolean;
}

interface ReplayTelemetryEvent {
  type: ReplayTelemetryType;
  sessionId: string | null;
  capturedAt: number;
  sdkVersion: string;
  level?: ConsoleMethod;
  message?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  failureReason?: string;
  initiator?: NetworkInitiator;
  requestType?: string;
  headers?: Record<string, string>;
}

let _buildSlug: string | null = null;
let _apiEndpoint = '';
let _queue: ReplayTelemetryEvent[] = [];
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _windowStart = 0;
let _eventsInWindow = 0;
let _isCapturingConsole = false;
let _originalConsole: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
let _originalFetch: typeof fetch | null = null;
let _originalXhrOpen: XMLHttpRequest['open'] | null = null;
let _originalXhrSend: XMLHttpRequest['send'] | null = null;
let _installedConsole = false;
let _installedNetwork = false;

export function startReplayTelemetry(
  buildSlug: string,
  apiEndpoint: string,
  options: StartReplayTelemetryOptions = {},
): void {
  _buildSlug = buildSlug;
  _apiEndpoint = apiEndpoint.replace(/\/+$/, '');
  if (!_intervalId) _intervalId = setInterval(flushReplayTelemetry, BATCH_INTERVAL_MS);
  if (options.consoleTelemetry !== false) startConsoleTelemetry();
  if (options.networkTelemetry !== false) startNetworkTelemetry();
}

export function stopReplayTelemetry(): void {
  stopConsoleTelemetry();
  stopNetworkTelemetry();
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  flushReplayTelemetry();
  _buildSlug = null;
  _apiEndpoint = '';
  _queue = [];
  _windowStart = 0;
  _eventsInWindow = 0;
}

function sdkVersion(): string {
  return typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : 'unknown';
}

function enqueueReplayTelemetry(event: Omit<ReplayTelemetryEvent, 'sessionId' | 'capturedAt' | 'sdkVersion'>): void {
  try {
    if (!withinRateLimit()) return;
    _queue.push({
      ...event,
      sessionId: getReplaySessionId(),
      capturedAt: Date.now(),
      sdkVersion: sdkVersion(),
    });
    if (_queue.length >= BATCH_SIZE_THRESHOLD) flushReplayTelemetry();
  } catch {
    // Telemetry capture must never affect the host app.
  }
}

function withinRateLimit(): boolean {
  const now = Date.now();
  if (_windowStart === 0 || now - _windowStart >= 60_000) {
    _windowStart = now;
    _eventsInWindow = 0;
  }
  if (_eventsInWindow >= MAX_EVENTS_PER_MINUTE) return false;
  _eventsInWindow += 1;
  return true;
}

function flushReplayTelemetry(): void {
  if (!_buildSlug || _queue.length === 0) return;
  const events = _queue.splice(0);
  sendTelemetry(TELEMETRY_PATH, { buildSlug: _buildSlug, events });
}

function startConsoleTelemetry(): void {
  if (_installedConsole || typeof console === 'undefined') return;
  _installedConsole = true;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as ConsoleMethod[]) {
    const original = console[method];
    if (typeof original !== 'function') continue;
    // Store the pristine method for restore; forward through this closure over it
    // so a caller that retained the wrapper still reaches the real console after
    // teardown clears the map, and repeated start/stop cycles do not nest binds.
    _originalConsole[method] = original;
    console[method] = (...args: unknown[]) => {
      if (!_isCapturingConsole && !isSdkLog(args)) {
        _isCapturingConsole = true;
        try {
          enqueueReplayTelemetry({
            type: 'console',
            level: method,
            message: serializeConsoleArgs(args),
          });
        } finally {
          _isCapturingConsole = false;
        }
      }
      original.apply(console, args);
    };
  }
}

function isSdkLog(args: unknown[]): boolean {
  return typeof args[0] === 'string' && args[0].startsWith(SDK_LOG_PREFIX);
}

function stopConsoleTelemetry(): void {
  if (!_installedConsole) return;
  for (const method of Object.keys(_originalConsole) as ConsoleMethod[]) {
    const original = _originalConsole[method];
    if (original) console[method] = original;
  }
  _originalConsole = {};
  _installedConsole = false;
  _isCapturingConsole = false;
}

function serializeConsoleArgs(args: unknown[]): string {
  const parts: string[] = [];
  let length = 0;
  for (const arg of args) {
    if (length >= MAX_MESSAGE_LENGTH) break;
    const part = serializeValue(arg);
    parts.push(part);
    length += part.length + 1;
  }
  return sanitizeAndTruncate(parts.join(' '), MAX_MESSAGE_LENGTH);
}

function serializeValue(value: unknown): string {
  try {
    if (typeof value === 'string') return sanitizeAndTruncate(value, MAX_SERIALIZED_ARG_LENGTH);
    if (value instanceof Error) return sanitizeAndTruncate(normalizeThrown(value).message, MAX_SERIALIZED_ARG_LENGTH);
    if (value === null || typeof value !== 'object') return sanitizeAndTruncate(String(value), MAX_SERIALIZED_ARG_LENGTH);
    // Track the current ancestor path, not every object seen: a value reachable
    // by two sibling properties is serialized twice, and only a genuine
    // back-reference to an ancestor becomes [Circular]. The path length also
    // enforces MAX_ARG_DEPTH, so the walk stops at depth 3 instead of traversing
    // the whole graph.
    const ancestors: object[] = [];
    const json = JSON.stringify(value, function (this: unknown, _key, nested) {
      if (typeof nested === 'function') return '[Function]';
      if (typeof nested === 'bigint') return nested.toString();
      if (nested && typeof nested === 'object') {
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(nested)) return '[Circular]';
        if (ancestors.length >= MAX_ARG_DEPTH) return '[Object]';
        ancestors.push(nested);
      }
      return nested;
    });
    return sanitizeAndTruncate(json ?? String(value), MAX_SERIALIZED_ARG_LENGTH);
  } catch {
    return normalizeThrown(value).message;
  }
}

function startNetworkTelemetry(): void {
  if (_installedNetwork) return;
  _installedNetwork = true;
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    const original = window.fetch;
    _originalFetch = original;
    // Close over the original so a retained reference to the wrapper still
    // forwards after teardown nulls _originalFetch.
    window.fetch = (input, init) => captureFetch(original, input, init);
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    _originalXhrOpen = XMLHttpRequest.prototype.open;
    _originalXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = captureXhrOpen;
    XMLHttpRequest.prototype.send = captureXhrSend;
  }
}

function stopNetworkTelemetry(): void {
  if (_originalFetch) {
    window.fetch = _originalFetch;
    _originalFetch = null;
  }
  if (_originalXhrOpen) {
    XMLHttpRequest.prototype.open = _originalXhrOpen;
    _originalXhrOpen = null;
  }
  if (_originalXhrSend) {
    XMLHttpRequest.prototype.send = _originalXhrSend;
    _originalXhrSend = null;
  }
  _installedNetwork = false;
}

async function captureFetch(
  original: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const startedAt = Date.now();
  let url: string;
  let method: string;
  try {
    url = resolveFetchUrl(input);
    method = resolveFetchMethod(input, init);
    if (isSdkEndpoint(url)) return original(input, init);
  } catch {
    // Instrumentation must never keep the host request from going out, even in
    // an environment where fetch exists but the Request/URL globals do not.
    return original(input, init);
  }
  const headers = requestHeaders(input, init);
  try {
    const response = await original(input, init);
    enqueueReplayTelemetry({
      type: 'network',
      initiator: 'fetch',
      requestType: 'fetch',
      method,
      url: redactUrl(url),
      status: response.status,
      durationMs: Math.max(0, Date.now() - startedAt),
      headers: redactHeaders(headers),
    });
    return response;
  } catch (error: unknown) {
    enqueueReplayTelemetry({
      type: 'network',
      initiator: 'fetch',
      requestType: 'fetch',
      method,
      url: redactUrl(url),
      status: 0,
      durationMs: Math.max(0, Date.now() - startedAt),
      failureReason: sanitizeAndTruncate(normalizeThrown(error).message, MAX_MESSAGE_LENGTH),
      headers: redactHeaders(headers),
    });
    throw error;
  }
}

function isRequest(input: unknown): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): HeadersInit | undefined {
  return init?.headers ?? (isRequest(input) ? input.headers : undefined);
}

const XHR_STATE = new WeakMap<XMLHttpRequest, { method: string; url: string; startedAt: number }>();

function captureXhrOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
  try {
    // Native open() ToString-coerces a non-string method; mirror that instead of
    // calling .toUpperCase() on it, and never let capture keep open() from running.
    XHR_STATE.set(this, {
      method: sanitizeAndTruncate(String(method).toUpperCase(), MAX_METHOD_LENGTH),
      url: String(url),
      startedAt: 0,
    });
  } catch {
    // Telemetry capture must never affect the host app.
  }
  return (_originalXhrOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
}

function captureXhrSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
  try {
    const state = XHR_STATE.get(this);
    if (state) {
      state.startedAt = Date.now();
      const finalize = () => {
        if (isSdkEndpoint(state.url)) return;
        enqueueReplayTelemetry({
          type: 'network',
          initiator: 'xmlhttprequest',
          requestType: 'xmlhttprequest',
          method: state.method,
          url: redactUrl(state.url),
          status: this.status || 0,
          durationMs: Math.max(0, Date.now() - state.startedAt),
          failureReason: this.status === 0 ? 'XMLHttpRequest failed' : undefined,
        });
      };
      this.addEventListener('loadend', finalize, { once: true });
    }
  } catch {
    // Telemetry capture must never affect the host app.
  }
  return (_originalXhrSend as (body?: Document | XMLHttpRequestBodyInit | null) => void).call(this, body);
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (isRequest(input)) return input.url;
  return String(input);
}

function resolveFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const raw = init?.method ?? (isRequest(input) ? input.method : 'GET');
  return sanitizeAndTruncate(String(raw).toUpperCase(), MAX_METHOD_LENGTH);
}

function isSdkEndpoint(url: string): boolean {
  if (_apiEndpoint === '') return false;
  try {
    // Compare origins, not a raw string prefix: a look-alike host
    // (api.bworlds.company.com) or a longer port (localhost:39410) must not be
    // misread as an SDK self-call and dropped from network telemetry.
    const base = typeof location !== 'undefined' ? location.href : undefined;
    return new URL(url, base).origin === new URL(_apiEndpoint, base).origin;
  } catch {
    return false;
  }
}

function isSensitiveKey(key: string): boolean {
  // Split camelCase (accessToken -> access, Token) and any non-alphanumeric
  // delimiter (access_token, x-access-token) into words, then match each.
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/i);
  return words.some((word) => SENSITIVE_KEY_WORDS.has(word.toLowerCase()));
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveKey(key)) parsed.searchParams.set(key, REDACTED);
    }
    return sanitizeAndTruncate(parsed.href, MAX_URL_LENGTH);
  } catch {
    return sanitizeAndTruncate(url, MAX_URL_LENGTH);
  }
}

function redactHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  try {
    const redacted: Record<string, string> = {};
    new Headers(headers).forEach((value, key) => {
      redacted[key] = isSensitiveKey(key) ? REDACTED : sanitizeAndTruncate(value, 200);
    });
    return Object.keys(redacted).length > 0 ? redacted : undefined;
  } catch {
    return undefined;
  }
}
