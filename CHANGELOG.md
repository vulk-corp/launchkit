# Changelog

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
