# Changelog

## [1.0.0] — 2026-03-31

### Breaking changes

- `init()` now returns a `LaunchKitInstance` instead of `void`. Existing code that ignores the return value continues to work unchanged.

### Added

- **Access gating**: `launchkit.check()` validates the client's `bworlds_token` against the BWORLDS API server-side. No build secret required in the client bundle.
- **Gate redirect**: `launchkit.getGateUrl()` returns the BWORLDS-hosted access page URL for the build.
- **Auto token reading**: `check()` reads the token from `?bworlds_token=` (URL param set by the gate page) or the `bworlds_token` cookie — no argument needed.
- **`instance.stop()`**: convenience method on the returned instance (equivalent to the existing top-level `stop()` export).
- `CheckResult` type exported from the package.

### Unchanged

Heartbeat monitoring and error capture behavior is identical to v0.2.0. Existing `init({ buildSlug })` calls work without modification.

---

## [0.2.0] — 2026-03-10

- Restore `window.onerror` on `stop()`.

## [0.1.0]

- Initial release: heartbeat + error capture.
