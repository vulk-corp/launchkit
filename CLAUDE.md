# LaunchKit SDK

`@bworlds/launchkit` — client SDK embedded in BWORLDS builders. Heartbeat, error capture, session replay (rrweb), access gating, trust badge. Remote-toggled from dashboard via `/api/telemetry/sdk-config`.

**Repo**: `vulk-corp/launchkit` (separate from `vulk-corp/bworlds` monorepo).

## Invariants

- **Never break the host app.** All features fail-open on backend outage. Telemetry drops silently.
- **Skip in cross-origin iframes** (Lovable/Bolt editor previews): error capture, replay, gate, badge. Heartbeat still runs.
- **No local feature flags.** Dashboard drives `monitoring`, `sessionReplay`, `badge`. `gate` stays local (behavioral).
- **rrweb is external + lazy.** Dynamic `import('./replay')` only on first session. Main bundle ~6.5 kB.

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
| `src/error-capture.ts` | `window.onerror` + `unhandledrejection`. Batches 5 errors OR 10s |
| `src/replay.ts` | rrweb record, 10s flush, 512 KB chunks, sessionStorage persistence |
| `src/badge-widget.ts` | Shadow DOM badge. Fetches `/api/telemetry/badge-counts` |
| `src/remote-config.ts` | `/api/telemetry/sdk-config` fetch, sessionStorage cache |
| `src/telemetry-sender.ts` | POST JSON + `keepalive`, silent fail |
| `src/fetch-util.ts` | `fetchJsonWithTimeout` (3s AbortController) |

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

**Tag push is the publish trigger.** `.github/workflows/release.yml` runs on `v*` tags: type-check → build → test → `npm publish --provenance`.

1. Merge to `main`.
2. Bump `package.json` version (must match the tag).
3. Append `CHANGELOG.md` entry.
4. Commit, push `main`.
5. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z` → CI publishes.
6. Fast-forward `next` to `main`: `git checkout next && git merge main --ff-only && git push origin next`.
7. Bump `@bworlds/launchkit` in monorepo `apps/bworlds-web/package.json`.

**Tag rules**
- **Always annotated** (`git tag -a …`). Never lightweight. Annotated tags carry tagger + date + message, survive `git describe`, and match industry signing flow.
- Tag message: `vX.Y.Z` (or the CHANGELOG headline if more context useful).
- Tag name = `v` + `package.json` version. No exceptions.
- Never push a tag for a version already on npm (guard in `release.yml` skips publish, but avoid anyway).
- Never re-tag. Bump patch instead.
- Never delete a published tag. Git history stays honest.
- Keep `next` in sync with `main` after every release tag.

Breaking → major. Feature → minor. Bugfix → patch. Never publish if CI red.
