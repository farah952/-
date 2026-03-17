# VaultDL — Free Video Downloader on Cloudflare Workers

A production-ready, lightweight video downloader supporting **YouTube**, **TikTok**, and **Instagram** — deployed entirely on Cloudflare's free tier with near-zero monthly cost.

---

## Features

- ✅ Download MP4, MP3, GIF
- ✅ Quality selection: 360p / 720p / 1080p
- ✅ Video trimming (start / end time)
- ✅ Metadata editing (title, artist)
- ✅ Rate limiting via KV
- ✅ Cloudflare edge caching
- ✅ Mobile-responsive UI
- ✅ SEO-optimized landing page
- ✅ Zero Node.js server required

---

## Architecture Overview

```
Browser (index.html + style.css + app.js)
         │
         │  GET /api/info?url=...
         │  GET /api/download?url=...
         ▼
Cloudflare Worker (worker.js)
         │
         ├─ Rate Limiting ──▶ KV Namespace (VAULTDL_CACHE)
         ├─ Metadata cache ──▶ KV Namespace (VAULTDL_CACHE)
         │
         └─ Extraction ──▶ cobalt.tools API (open source)
                                │
                                └─▶ YouTube / TikTok / Instagram
```

**Extraction backend:** [cobalt.tools](https://cobalt.tools) — an open-source video extraction API. You can use the public instance or [self-host it](https://github.com/imputnet/cobalt) for free on Railway, Render, or Fly.io.

---

## Prerequisites

- [Node.js 18+](https://nodejs.org/) (for Wrangler CLI only)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is enough)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

---

## Step-by-Step Deployment Guide

### Step 1 — Install Wrangler CLI

```bash
npm install -g wrangler
```

### Step 2 — Authenticate with Cloudflare

```bash
wrangler login
```

This opens a browser window. Log in to your Cloudflare account and authorize Wrangler.

### Step 3 — Clone / Download the project

```bash
git clone https://github.com/yourname/vaultdl.git
cd vaultdl
```

Or just place all 5 files (`index.html`, `style.css`, `app.js`, `worker.js`, `wrangler.toml`) in a folder.

### Step 4 — Install worker dependencies

The worker uses `@cloudflare/kv-asset-handler` to serve static files. Install it:

```bash
npm install
```

### Step 5 — Create the KV Namespace

KV is used for rate limiting and metadata caching.

```bash
wrangler kv:namespace create VAULTDL_CACHE
```

Copy the `id` from the output (looks like `abc123...`).

Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

```toml
[[kv_namespaces]]
binding = "VAULTDL_CACHE"
id = "abc123..."   # ← paste your id here
```

### Step 6 — Deploy to Cloudflare Workers

```bash
wrangler deploy
```

Wrangler will:
1. Bundle `worker.js`
2. Upload `index.html`, `style.css`, `app.js` as static assets
3. Return a URL like `https://vaultdl.yourname.workers.dev`

Open that URL in your browser — your site is live! 🎉

### Step 6 — Test the API

```bash
# Test metadata endpoint
curl "https://vaultdl.yourname.workers.dev/api/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Health check
curl "https://vaultdl.yourname.workers.dev/api/health"
```

---

## Connecting a Custom Domain

### Option A — Cloudflare-managed domain (easiest)

1. Add your domain to Cloudflare (or transfer/register it there)
2. In `wrangler.toml`, uncomment and update:
   ```toml
   [[routes]]
   pattern = "yourdomain.com/*"
   zone_name = "yourdomain.com"
   ```
3. Redeploy: `wrangler deploy`

### Option B — External domain with CNAME

1. In your DNS provider, add a CNAME:
   ```
   @ → vaultdl.yourname.workers.dev
   ```
2. In Cloudflare Workers dashboard → your worker → **Triggers** → **Custom Domains** → Add your domain.

---

## Self-Hosting the cobalt Backend (Recommended for Production)

The default config points to `https://cobalt.tools/api` (public, shared, may have limits). For production, self-host cobalt:

### Deploy cobalt on Railway (free tier)

1. Fork [https://github.com/imputnet/cobalt](https://github.com/imputnet/cobalt)
2. Connect to [Railway](https://railway.app) and deploy
3. Set env vars: `API_URL`, `WEB_URL` per cobalt's docs
4. Get your Railway URL (e.g. `https://cobalt-production-xxxx.up.railway.app`)

### Update `worker.js`

```js
const CONFIG = {
  COBALT_API: 'https://cobalt-production-xxxx.up.railway.app/api',
  // ... rest unchanged
};
```

Redeploy: `wrangler deploy`

---

## Local Development

```bash
wrangler dev
```

This starts a local dev server at `http://localhost:8787` with hot reload.

---

## Environment Variables (optional)

Set secrets via Wrangler if you want to restrict your cobalt instance:

```bash
wrangler secret put COBALT_API_KEY
```

Then read it in `worker.js` via `env.COBALT_API_KEY`.

---

## Project File Structure

```
/project
├── index.html      ← Landing page + SPA shell
├── style.css       ← All styles (dark industrial theme)
├── app.js          ← Frontend JS (fetch, render, download)
├── worker.js       ← Cloudflare Worker (API backend + static serving)
├── wrangler.toml   ← Worker configuration
├── package.json    ← Worker npm dependencies
└── README.md       ← This file
```

---

## API Reference

### `GET /api/info`

Fetch video metadata.

| Param | Required | Description |
|-------|----------|-------------|
| `url` | ✅ | Full video URL (YouTube, TikTok, Instagram) |

**Response:**
```json
{
  "title": "My Video Title",
  "author": "Channel Name",
  "thumbnail": "https://...",
  "duration": 183,
  "platform": "YouTube",
  "originalUrl": "https://..."
}
```

---

### `GET /api/download`

Download or proxy a video/audio file.

| Param | Required | Description |
|-------|----------|-------------|
| `url` | ✅ | Video URL |
| `format` | ✅ | `mp4`, `mp3`, `gif` |
| `quality` | — | `360`, `720` (default), `1080` |
| `from` | — | Start time, e.g. `1:30` |
| `to` | — | End time, e.g. `3:45` |
| `title` | — | Filename title tag |
| `artist` | — | Filename artist tag |

**Response:** Binary stream with `Content-Disposition: attachment` header.

---

## Rate Limits

| Metric | Limit |
|--------|-------|
| Requests per IP | 20 per minute |
| Max video duration | 2 hours |

---

## Cost Estimate (Cloudflare Free Tier)

| Resource | Free Tier Limit | Typical Usage |
|----------|----------------|---------------|
| Worker requests | 100,000/day | ~10,000/day |
| KV reads | 100,000/day | ~20,000/day |
| KV writes | 1,000/day | ~5,000/day |
| Worker CPU | 10ms/request | ~2ms avg |

**Estimated monthly cost: $0** for typical personal/small project usage.

---

## Security Considerations

1. **Input validation** — All URLs are validated against an allowlist of platforms before processing.
2. **Rate limiting** — Per-IP rate limiting via KV prevents abuse.
3. **No storage** — Files are streamed directly; nothing is stored.
4. **CORS** — Set `CONFIG.CORS_ORIGIN` to your domain in production (replace `'*'`).
5. **No private videos** — Only publicly accessible videos can be downloaded.

---

## Customization

### Change accent color
In `style.css`, update:
```css
--accent: #e8f427;  /* chartreuse → change to any color */
```

### Change branding
In `index.html`, replace all instances of `VaultDL` and `vaultdl.com`.

### Increase rate limits
In `worker.js`:
```js
RATE_LIMIT_REQUESTS: 50,   // requests per window
RATE_LIMIT_WINDOW_MS: 60_000,
```

---

## Troubleshooting

**"Could not extract video info"**
→ The cobalt API may be temporarily unavailable. Try self-hosting cobalt.

**Rate limit errors**
→ You've exceeded 20 requests/minute. Wait 60 seconds.

**CORS errors in development**
→ Run `wrangler dev` and access via `localhost:8787`, not by opening `index.html` directly.

**KV errors on deploy**
→ Make sure you replaced `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` in `wrangler.toml`.

---

## License

MIT — use freely, modify freely, deploy freely.

---

## Credits

- Extraction powered by [cobalt.tools](https://cobalt.tools) (open source)
- Deployed on [Cloudflare Workers](https://workers.cloudflare.com)
