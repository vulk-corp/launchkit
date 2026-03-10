# @bworlds/launchkit

Monitoring and error capture SDK for AI-built apps. One line of code, two readiness checks pass.

## Install

```bash
npm install @bworlds/launchkit
```

## Quick Start

```js
import { init } from '@bworlds/launchkit';

init({ buildSlug: 'my-app' });
```

That's it. The SDK will:
- Send heartbeats every 5 minutes to confirm your app is alive
- Capture uncaught JS errors (`window.onerror`, `unhandledrejection`) and report them

## Lovable / Bolt

Paste this prompt into your AI builder:

> Install @bworlds/launchkit and add `import { init } from '@bworlds/launchkit'; init({ buildSlug: 'my-app' });` to the app entry point.

Replace `my-app` with your build slug from the BWORLDS dashboard.

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
| Heartbeat | `setInterval` sends `POST /api/telemetry/heartbeat` every 5 min |
| Error capture | `window.onerror` + `unhandledrejection` batched and sent to `POST /api/telemetry/errors` |

All requests are identified by `buildSlug`. No API key required. Write-only (the SDK never reads your data).

## Demo Recording

The SDK also includes demo recording (rrweb-based session replay). This is activated via URL parameters, not through `init()`. See the [BWORLDS docs](https://bworlds.co) for details.

## License

MIT
