# Changelog

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
