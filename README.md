# @bworlds/launchkit

Monitoring and access gating SDK for AI-built apps. Drop-in integration for Lovable, Bolt, and Base44.

## Install

```bash
npm install @bworlds/launchkit
```

## Quick Start

```js
import { init } from '@bworlds/launchkit';

// ── 1. Initialize once (app entry point) ─────────────────
const launchkit = init({ buildSlug: 'my-app' });
// Activates heartbeat monitoring and error tracking automatically.

// ── 2. Gate any protected page ────────────────────────────
// Remove the 3 lines below to keep your app open to everyone.
const session = await launchkit.check();
if (!session.valid) redirect(launchkit.getGateUrl());
// Redirects unauthenticated users to the BWORLDS access page.

// session.email, session.accessType are available when valid
```

Replace `my-app` with your build slug from the BWORLDS dashboard.

## Lovable / Bolt / Base44

Paste the snippet above directly into your AI builder as a prompt. The AI will handle the integration.

## CDN (no bundler)

```html
<script src="https://unpkg.com/@bworlds/launchkit"></script>
<script>
  BWorldsLaunchKit.init({ buildSlug: 'my-app' });
</script>
```

## Configuration

```js
init({
  buildSlug: 'my-app',           // Required: your build slug
  apiEndpoint: 'https://...',    // Optional: custom API endpoint
  heartbeatInterval: 300000,     // Optional: heartbeat interval in ms (default: 5 min)
  enableErrorCapture: true,      // Optional: enable error capture (default: true)
  enableHeartbeat: true,         // Optional: enable heartbeat (default: true)
});
```

## What it does

| Feature | How it works |
|---------|-------------|
| Heartbeat | Sends `POST /api/telemetry/heartbeat` every 5 min |
| Error capture | `window.onerror` + `unhandledrejection` batched and sent to `POST /api/telemetry/errors` |

All requests are identified by `buildSlug`. No API key required. Write-only.

## License

MIT
