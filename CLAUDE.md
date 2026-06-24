# LaunchKit SDK

`@bworlds/launchkit` — client SDK embedded in BWORLDS builders. Heartbeat, error capture, session replay (rrweb), access gating, trust badge. Remote-toggled from dashboard via `/api/telemetry/sdk-config`.

**Repo**: `vulk-corp/launchkit` (separate from `vulk-corp/bworlds` monorepo).

## Invariants

- **Never break the host app.** All features fail-open on backend outage. Telemetry drops silently.
- **Skip in cross-origin iframes** (Lovable/Bolt editor previews): error capture, replay, gate, badge. Heartbeat still runs.
- **No local feature flags.** Dashboard drives `monitoring`, `sessionReplay`, `badge`. `gate` stays local (behavioral).
- **rrweb is external + lazy.** Dynamic `import('./replay')` only on first session. Main bundle ~6.5 kB.
- **Replay owns the session id; error capture only reads it.** `replay.ts` publishes the active session id through `session-state.ts` (set on open/resume/rotation, cleared on stop, 429 cap stop, and failed start) — never export a getter from `replay.ts`, that defeats the dynamic-import boundary. `enqueueError` stamps `sessionId` + `capturedAt` at capture time, never at flush: a batch can span a session rotation. `backstampQueuedErrors` fills null-session entries only, preserves `capturedAt`, and is called only from `startReplay`'s success path.
- **Telemetry strings are string-typed, capped, and well-formed.** `enqueueError` is the single enforcement chokepoint for `message` (≤ `MAX_MESSAGE_LENGTH`, 5000), `stack` (≤ `MAX_STACK_LENGTH`, 10000), and `url` (≤ `MAX_URL_LENGTH`, 2048): always strings, lone surrogates replaced with U+FFFD, never cut mid-surrogate-pair. The API rejects the entire `/api/telemetry/errors` batch when one item carries an invalid field. `normalizeThrown` never throws; unreadable values become `[error details could not be read]`.
- **Navigation watcher restores the host's history on stop.** The SPA navigation watcher (history `pushState`/`replaceState` patch + `popstate` listener) lives inside the lazily-imported replay module, installs when recording starts, and tears down fully on stop — original `history.pushState`/`replaceState` restored, listener removed. Never leave the host app's history patched after stop. Skip entirely in cross-origin iframes; wrap install/emit in try/catch so route changes can never break the host app.

## Commands

```bash
npm run build        # vite build + tsc --emitDeclarationOnly
npm run type-check   # tsc --noEmit
npm test             # vitest run
npx vitest run tests/replay.test.ts   # single file
```

CI: Node 22, runs on main/next push + PRs (type-check, build, test).

## Architecture

| File | Role |
|------|------|
| `src/index.ts` | Orchestrator. `init()` wires modules, standalone `check()`/`getGateUrl()` |
| `src/check.ts` | Token validation. Reads `?bworlds_token=` or cookie. Persists cookie, strips URL |
| `src/heartbeat.ts` | 5 min interval ping → `/api/telemetry/heartbeat` |
| `src/error-capture.ts` | `window.onerror` + `unhandledrejection` + `console.error` wrapper. Batches 5 errors OR 10s, flushes on page hidden. Stamps `sessionId` (from session-state) + `capturedAt` at enqueue |
| `src/network-capture.ts` | `window.fetch` wrapper. Enqueues HTTP ≥ 400 responses and rejected fetches with `Network error - {method} {url}` prefix. Skips `apiEndpoint` URLs (no self-capture) |
| `src/normalize-thrown.ts` | Any thrown value → `{message, stack}`: Error as-is, string/primitive verbatim, object → `message` field → `error` field → safe JSON → `[error details could not be read]`. Depth-capped, never throws. Exports `truncateMessage`, `sanitizeAndTruncate` + the `MAX_*_LENGTH` server caps |
| `src/replay.ts` | rrweb record, 10s flush, 512 KB chunks, sessionStorage persistence. Publishes session id to session-state, back-stamps queued errors on start. Watches SPA navigation (history patch + popstate) and emits a `navigation` custom event per route change |
| `src/session-state.ts` | Shared replay-session id holder. replay writes, error-capture reads at enqueue. Zero imports |
| `src/identity-state.ts` | Shared identity holder. `index.ts` writes, replay payload reads |
| `src/badge-widget.ts` | Shadow DOM badge. Fetches `/api/telemetry/badge-counts` |
| `src/remote-config.ts` | `/api/telemetry/sdk-config` fetch, sessionStorage cache |
| `src/telemetry-sender.ts` | POST JSON + `keepalive`, silent fail |
| `src/fetch-util.ts` | `fetchJsonWithTimeout` (3s AbortController) |

## Message normalization rules

Design rationale for `normalize-thrown.ts` and the capture paths — keep it here, not in code comments.

- `MAX_MESSAGE_LENGTH`/`MAX_STACK_LENGTH`/`MAX_URL_LENGTH` mirror the server's `ClientErrorItem` field caps (`telemetry_schemas.py` in bworlds-api). One invalid item 422s the whole batch — that is why `enqueueError` is the single enforcement chokepoint and why every field is sanitized there even when a capture path already produced a safe value.
- Surrogate handling is two-sided: replace lone surrogates anywhere (a pre-existing one fails the server's UTF-8 encode), and never cut at a position that splits a pair (the cut would reintroduce the failure). `toWellFormed()` is ES2024; the regex fallback covers older engines, hence the feature-detect cast.
- Getter-chain recursion is hard-capped at depth 3: an Error subclass whose `message` getter returns another Error (or itself) would otherwise recurse to stack overflow inside hot capture paths. Legitimate chains never exceed depth 2.
- An object's empty-string `message` falls through to its `error` field or JSON form — the server maps `""` to "Unknown error", which carries less signal.
- The `error`-field hop happens only at depth 0: the outermost object may delegate once; deeper levels serialize.
- Full `JSON.stringify` before truncation is deliberate: JSON size is unknowable without serializing, and a budgeted replacer would alter the kept prefix. Cost is one O(size) pass per captured value; an engine `RangeError` falls through to the fallback.
- `onerror`: a non-Error `error` param is normalized (the browser-stringified `message` would read "Uncaught [object Object]"); Error instances and absent `error` (cross-origin "Script error.") keep the browser message untouched. The capture body is wrapped in try/catch so a poisoned value (throwing `stack` getter) drops one capture without blocking the host app's own onerror chain.
- Console path: an Error arg with an empty message falls back to `String(arg)` ("Error: ..."); non-Error args run through a budget loop that stops normalizing once the joined length passes the message cap — `enqueueError` would cut the excess anyway, so their stringify cost is skipped.
- `[error details could not be read]` is builder-facing copy (dashboard row, alert email, Fix prompt): plain language, and a single literal keeps server-side grouping intact.

## Navigation event contract

SPA route changes are recorded as rrweb custom events so the backend distiller can segment a single-page session into pages. The contract is **stable** — the distiller (`bworlds-api`, #889 workstream 3) will match on it and append to `pages_visited` once that wiring ships. Do not rename the tag or reshape the payload without coordinating that change.

- **tag**: `"navigation"`
- **payload**: `{ href: string, title?: string }` — `href` is `location.href` (full URL, recorded exactly as rrweb already records META URLs; no new masking, query-param PII is a separate decision), `title` is `document.title` when non-empty.
- **Emitted on**: `history.pushState`, `history.replaceState` (both patched — neither fires natively), and `popstate` (back/forward). `hashchange` is not covered (hash routers fall through); revisit if a HashRouter build needs in-session pages.
- **Deduped**: an emission whose resolved `href` equals the last emitted one is dropped. The baseline is seeded to `location.href` at install, so the initial full-load META is not double-counted and `replaceState` query-param churn is silenced.
- **Across rotation**: the watcher survives an idle session rotation (the patch is intentionally not torn down on rotate). `_rotateSession` clears the dedup baseline so each rotated session re-emits its entry URL instead of swallowing it as a duplicate.
- Capture only. The initial page is already represented by rrweb's full-load META (type 4); no synthetic navigation event is emitted for it.

## API endpoints

| Path | Module | Method |
|------|--------|--------|
| `/api/telemetry/heartbeat` | heartbeat | POST |
| `/api/telemetry/errors` | error-capture | POST |
| `/api/telemetry/replay-events` | replay | POST + sendBeacon on unload |
| `/api/telemetry/sdk-config` | remote-config | GET |
| `/api/telemetry/badge-counts` | badge-widget | GET |
| `/api/monetization/validate-token` | check | POST |

## Config naming

- `apiEndpoint` — telemetry + token validation base URL. Not `apiOrigin`.
- `gateOrigin` — `/access/:slug` redirect target. Defaults to `https://app.bworlds.co`.
- `gate` — boolean, auto-gating toggle.

Replay payload includes `token` (read from `bworlds_token` cookie) so backend resolves user identity.

## Testing

- jsdom env, globals on (no import needed for `describe`/`it`/`vi`).
- Mock every sibling module per file. Reset in `beforeEach`.
- Fake timers for heartbeat/error-capture: `vi.useFakeTimers()` + `vi.advanceTimersByTime()`.
- Replay tests: hoisted `vi.hoisted()` to capture rrweb emit callback. `vi.setSystemTime()` for session rotation.
- Always pass `gate: false` in non-gate tests (auto-gate triggers overlay + `check()` side effects).

## Release

**Branch push is the publish trigger.** `.github/workflows/ci.yml` runs type-check → build → test, creates the missing annotated `vX.Y.Z` tag from `package.json`, then dispatches `.github/workflows/release.yml` to publish with provenance.

Stable releases:
1. Merge to `main`.
2. Bump `package.json` to a stable version.
3. Append `CHANGELOG.md` entry.
4. Commit and push `main` → CI creates `vX.Y.Z` and publishes with npm dist-tag `latest`.
5. Bump `@bworlds/launchkit` in monorepo `apps/bworlds-web/package.json`.

Prereleases:
1. Work on `next`.
2. Bump `package.json` to a prerelease version such as `1.10.0-alpha.0`.
3. Append `CHANGELOG.md` prerelease entry if needed.
4. Commit and push `next` → CI creates `vX.Y.Z-alpha.N` and publishes with npm dist-tag `next`.
5. Do not fast-forward `next` from `main` automatically while it carries prerelease work.

**Tag rules**
- **Always annotated** (`git tag -a …`). Never lightweight. Annotated tags carry tagger + date + message, survive `git describe`, and match industry signing flow.
- Tag message: `vX.Y.Z` (or the CHANGELOG headline if more context useful).
- Tag name = `v` + `package.json` version. No exceptions.
- Never push a tag for a version already on npm (CI guards skip publish, but avoid anyway).
- Never re-tag. Bump patch instead.
- Never delete a published tag. Git history stays honest.
- `main` can only publish stable versions. `next` can only publish prerelease versions.

Breaking → major. Feature → minor. Bugfix → patch. Prerelease → `-alpha.N` or `-beta.N`. Never publish if CI red.
