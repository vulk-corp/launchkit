# Changelog

## [1.12.0] — 2026-06-24

### Added

- **SPA navigation capture in session replay**: client-side route changes are now recorded as first-class navigation events. The replay module patches `history.pushState`/`history.replaceState` (neither fires an event natively) and listens for `popstate` (back/forward), emitting an rrweb custom event on each real URL change. This fixes downstream page segmentation, which previously saw a whole SPA session as a single page because rrweb only emits a META event on full page loads.
  - **Event contract** (stable — the backend distiller will match on it; backend wiring in progress, #889 workstream 3): `tag: "navigation"`, `payload: { href: string, title?: string }`, where `href` is `location.href` (full URL, consistent with rrweb META URLs — no new masking) and `title` is `document.title` when non-empty.
  - **Dedup**: an emission is skipped when the resolved URL equals the last emitted URL, killing `replaceState` query-param churn and the no-op `replaceState` SPAs fire on load (so the initial full-load META is not double-counted).
  - **Session rotation**: the watcher survives an idle session rotation (route changes keep flowing into the rotated session) and resets its dedup baseline on rotation, so a rotated session re-emits its entry URL even when it equals the previous session's last route.
  - **Lifecycle + safety**: the watcher lives inside the lazily-imported replay module, installs when recording starts, and tears down fully on stop (original `history.pushState`/`replaceState` restored, `popstate` listener removed) so the host app's history is never left patched. Each wrapper carries the genuine original, so a re-install on a hardened host (where teardown could not restore) recovers it instead of stacking a second wrapper. It is skipped entirely in cross-origin iframes (Lovable/Bolt editor previews) and every path fails open so it can never break the host app's routing.

## [1.11.1] — 2026-06-19

### Fixed

- **Vite dev replay snapshots without CSS**: session replay now waits briefly for Vite's runtime-injected `style[data-vite-dev-id]` before starting rrweb, and ignores later Vite dev `FullSnapshot` events that drop CSS after a styled snapshot has already been captured. This prevents localhost/Lovable dev recordings from replaying as raw unstyled HTML when rrweb snapshots race CSS injection.

## [1.11.0] — 2026-06-18

### Added

- **Error–Session Link**: every captured error now carries the recorded session it happened in. `/api/telemetry/errors` items gain `sessionId` (the active recording's Client Session ID, null when replay is not recording) and `capturedAt` (client-clock capture timestamp, epoch ms). Both are stamped at enqueue time, not at flush, so a batch spanning a session rotation keeps each error on the session it actually occurred in. Additive payload fields — older servers ignore them.
- **`session-state.ts`**: new shared session-state module (mirrors `identity-state.ts`, including its `globalThis`-backed storage so the session id stays shared when CDN ESM providers split LaunchKit across bundle files). Replay writes the session id on open/resume/rotation and clears it on stop and on the 429 daily-cap stop; error capture reads it at enqueue time without importing the rrweb-bearing replay module.
- **Page-load error back-stamp**: errors that fire while the replay module is still loading (dynamic import window) are queued with a null session and back-stamped with the session id the moment recording genuinely starts. Capture timestamps are preserved; only the session link is filled in.
- **Error flush on page hidden**: the error queue now flushes on `visibilitychange → hidden` (keepalive fetch), so errors captured in the final seconds of a page life reach the API instead of dying with the tab.

### Fixed

- **Stale session id after failed replay start**: when the rrweb import fails or `record()` returns no stop handle, the shared session id is cleared so subsequent errors are not stamped with a session that will never record. Queued errors already stamped with a fresh session that never started recording are un-stamped too; resumed sessions keep their stamps (prior footage exists).

## [1.10.0] — 2026-06-18

### Added

- **Automatic Supabase identity for replays**: LaunchKit now detects Lovable-style Supabase Auth sessions from browser storage and attaches `userEmail` / `userId` to replay chunks without changing the public `init({ buildSlug })` snippet.
- **Optional Supabase client bridge**: `launchkit.connectSupabase(supabase)` can be used by integration agents or advanced apps to feed identity through Supabase's official `getSession()` / `onAuthStateChange()` APIs.

### Privacy

- The Supabase bridge reads only `session.user.email` and `session.user.id`. Supabase access tokens, refresh tokens, user metadata, and application tables are not sent to BWORLDS.

## [1.9.4] — 2026-06-16

### Fixed

- **Replay identity lost when CDN chunks split the SDK**: identity state now lives on `globalThis`, so separate ESM chunks or module instances share the same `identify()` values.
- **Replay no longer imports its own identity store**: `index.ts` injects the shared identity getter into `startReplay()`, making the identity path explicit and resilient to CDN or bundler chunking.

## [1.9.3] — 2026-06-15

### Fixed

- **Duplicate replay `sequenceNumber=0` uploads**: replay chunks now reserve and persist sequence numbers before upload, including `sendBeacon` unload flushes and oversized split chunks. Exact retries keep the same numbered payload, while different payloads cannot reuse the same `(sessionId, sequenceNumber)`.
- **Replay startup robustness**: concurrent `startReplay()` calls are guarded before rrweb finishes loading, and the first chunk of a replay session must include a FullSnapshot so newly rotated sessions remain independently replayable.

## [1.9.2] — 2026-06-15

### Fixed

- **Replay sessions split too aggressively after tab-away gaps**: replay idle rotation now follows the 15-minute session-continuity window used by Sentry Replay. Users returning within 15 minutes keep the same replay session, while the 60-minute max session rotation still applies.
- **Package metadata drift**: package version metadata is aligned with the next publishable version after npm `1.9.1`.

## [1.9.1] — 2026-06-11

### Fixed

- **Non-Error throws captured as "[object Object]"**: plain objects, primitives, and exotic values thrown in builder apps now produce readable messages on all four capture paths (unhandled rejection, `window.onerror`, network, console). New `normalizeThrown()` derives the message from a non-empty `message` field, then an `error` field (one hop), then safe JSON, then a plain `[error details could not be read]` fallback. Error instances are untouched.
- **Silent telemetry batch loss**: `enqueueError` now enforces the wire contract for every field — string-typed, lone surrogates replaced, never cut mid-surrogate-pair, capped at the server limits (message 5000, stack 10000, url 2048). Previously one oversized or malformed item caused the API to reject the entire 5-error batch.
- **Hardened hot paths**: `window.onerror` capture can no longer skip the host app's own handler chain when a hostile getter throws; the console wrapper stops serializing arguments once the message cap is reached.

## [1.6.1] — 2026-04-17

### Fixed

- **Mid-session rotation on idle**: the SDK now rotates to a fresh session id when the gap between rrweb events exceeds 4 minutes — one minute below the server's 5-minute idle-assembly threshold. Previously the SDK kept writing to a session id that the server had already closed, so chunks arriving after a tab-away were discarded as late. On rotation, the old buffer is flushed under the old identity and `rrweb.record.takeFullSnapshot(true)` emits a fresh type-2 so the new session is independently replayable.
- **Stale seq increments across rotation**: `_flushChunk` no longer mutates module state. Callers decide whether to advance `_sequenceNumber` and only do so when the session hasn't rotated mid-flight.

## [1.6.0] — 2026-04-17

### Added

- **Trust badge widget**: a floating "Runs on BWORLDS · {passed}/{total} verified" pill, mounted bottom-right on the consumer site. Activated server-side via the dashboard toggle on the proof-seal page (no consumer-side flag). Rendered inside a shadow DOM at `z-index: 2147483000` so host-site CSS cannot interfere. Links to the public trust page in a new tab with `rel="noopener noreferrer"`.
- **`SdkRemoteConfig.badge`**: new boolean field returned by `/api/telemetry/sdk-config`. Defaults to `false` (opt-in). When `true`, the SDK fetches `/api/telemetry/badge-counts` once per pageload (3s abort timeout) and renders the pass/total counts.
- **Graceful fallback**: if the counts endpoint fails or times out, the badge still mounts with the "Runs on BWORLDS" label only (no counts suffix).
- **Sandboxed-iframe skip**: the badge does not mount inside cross-origin iframes (e.g. Lovable/Bolt editor previews), same policy as error capture and session replay.

## [1.5.0] — 2026-04-16

### Added

- **`gateOrigin` config option**: override the origin used for `/access/:slug` redirects. Defaults to `https://app.bworlds.co`. Lets consumer apps point the gate at a local BWORLDS web instance during development without disabling the built-in gate + overlay. See the "Local development against a BWorlds dev stack" section of the README.

## [1.4.0] — 2026-04-16

### Added

- **User identification in replays**: replay chunks now include the `bworlds_token` (read from cookie) so the backend can resolve sessions to a user email or IP.
- **Session persistence**: replay sessions survive page navigations via sessionStorage. Sessions resume if idle < 15 min and age < 60 min, otherwise rotate to a new session.

### Fixed

- Module state (sessionId, sequenceNumber) is now reset on `stopReplay()` so the next `startReplay()` resolves cleanly from sessionStorage.

## [1.3.0] — 2026-04-14

### Added

- **Session replay**: records user sessions via rrweb (lazy-loaded, ~3.5 kB chunk). Flushes compressed snapshots to the BWORLDS API every 10 seconds.
- **Remote config**: features are now controlled from the BWORLDS dashboard. Config is fetched on init and cached in sessionStorage. Fail-open: if the backend is unreachable, all features stay enabled.
- **Sandboxed iframe detection**: error capture and replay are skipped inside cross-origin iframes (e.g. Lovable/Bolt editor previews).

### Changed

- `LaunchKitConfig` simplified to `{ buildSlug, apiEndpoint?, gate? }`. The `enableHeartbeat`, `enableErrorCapture`, and `heartbeatInterval` options have been removed in favor of remote config.
- Standalone `check()` and `getGateUrl()` exports now work after `init()` has been called.

## [1.2.0] — 2026-04-14

### Added

- **Automatic token persistence**: `check()` now saves the `bworlds_token` in a cookie after successful validation. Subsequent page loads use the cookie, so the token no longer needs to stay in the URL.
- **URL cleanup**: when the token comes from `?bworlds_token=` in the URL, it is stripped from the address bar after validation via `history.replaceState`. Other query params are preserved.
- **Cookie cleanup on rejection**: on 401/403 the stale cookie is cleared to prevent redirect loops.
- **Gate loading overlay**: when `gate` is enabled (default), a full-screen "Verifying access..." overlay is shown while the access check is in flight. Removes the flash of protected content before redirect.

## [1.0.2] — 2026-04-07

### Fixed

- Access check now **fails open** when the backend returns a server error (5xx / network failure). Previously, a backend outage would lock users out.

## [1.0.1] — 2026-04-06

### Fixed

- `check()` sends an empty token instead of returning early when no token is found (lets the backend return the proper "no access" response).
- Gate URL now uses the correct domain.

## [1.0.0] — 2026-03-31

### Breaking changes

- `init()` now returns a `LaunchKitInstance` instead of `void`. Existing code that ignores the return value continues to work unchanged.

### Added

- **Access gating**: `launchkit.check()` validates the client's `bworlds_token` against the BWORLDS API server-side. No build secret required in the client bundle.
- **Gate redirect**: `launchkit.getGateUrl()` returns the BWORLDS-hosted access page URL for the build.
- **Auto token reading**: `check()` reads the token from `?bworlds_token=` (URL param set by the gate page) or the `bworlds_token` cookie -- no argument needed.
- **`instance.stop()`**: convenience method on the returned instance (equivalent to the existing top-level `stop()` export).
- `CheckResult` type exported from the package.

### Unchanged

Heartbeat monitoring and error capture behavior is identical to v0.2.0. Existing `init({ buildSlug })` calls work without modification.

---

## [0.2.0] — 2026-03-10

- Restore `window.onerror` on `stop()`.

## [0.1.0]

- Initial release: heartbeat + error capture.
