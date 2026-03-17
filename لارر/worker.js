/**
 * VaultDL – Cloudflare Worker (worker.js)
 *
 * Serves:
 *   Static files  → index.html, style.css, app.js  (via __STATIC_CONTENT KV)
 *   GET /api/info?url=...      → video metadata JSON
 *   GET /api/download?url=...  → proxied media stream
 *   GET /api/health            → health check
 *
 * Extraction: cobalt.tools v10 API (open source, self-hostable)
 * Docs: https://github.com/imputnet/cobalt
 */

import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';
const assetManifest = JSON.parse(manifestJSON);

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────
const CONFIG = {
  // cobalt.tools public API (v10+). For production, self-host:
  // https://github.com/imputnet/cobalt
  COBALT_API: 'https://cobalt.tools',

  RATE_LIMIT_REQUESTS: 20,
  RATE_LIMIT_WINDOW_MS: 60_000,
  CORS_ORIGIN: '*',
  CACHE_TTL_METADATA: 300,
  CACHE_TTL_STREAM: 30,
};

// ─────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── CORS preflight ──
    if (request.method === 'OPTIONS') {
      return addCors(new Response(null, { status: 204 }));
    }

    // ── API routes ──
    if (path.startsWith('/api/')) {
      if (request.method !== 'GET') {
        return addCors(jsonError('Method not allowed', 405));
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await checkRateLimit(ip, env))) {
        return addCors(jsonError('Rate limit exceeded. Please wait a minute.', 429, { 'Retry-After': '60' }));
      }
      try {
        if (path === '/api/info')     return addCors(await handleInfo(url, env, ctx));
        if (path === '/api/download') return addCors(await handleDownload(url));
        if (path === '/api/health')   return addCors(json({ status: 'ok', ts: Date.now() }));
      } catch (err) {
        console.error('[VaultDL]', err?.message || err);
        return addCors(jsonError('Internal server error', 500));
      }
      return addCors(jsonError('Not found', 404));
    }

    // ── Static assets ──
    try {
      return await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        {
          ASSET_NAMESPACE: env.__STATIC_CONTENT,
          ASSET_MANIFEST:  assetManifest,
          cacheControl: { browserTTL: 3600, edgeTTL: 86400 },
        }
      );
    } catch {
      // SPA fallback → index.html
      try {
        const indexReq = new Request(new URL('/index.html', request.url).toString(), request);
        return await getAssetFromKV(
          { request: indexReq, waitUntil: ctx.waitUntil.bind(ctx) },
          { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
        );
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
  },
};

// ─────────────────────────────────────────────
// /api/info
// ─────────────────────────────────────────────
async function handleInfo(url, env, ctx) {
  const videoUrl = url.searchParams.get('url');
  if (!videoUrl) return jsonError('Missing url parameter', 400);
  const vErr = validateVideoUrl(videoUrl);
  if (vErr) return jsonError(vErr, 400);

  // KV cache check
  const cacheKey = `info:${videoUrl}`;
  if (env.VAULTDL_CACHE) {
    try {
      const cached = await env.VAULTDL_CACHE.get(cacheKey);
      if (cached) return new Response(cached, {
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    } catch {}
  }

  const meta = await fetchMetadata(videoUrl);
  if (meta.error) return jsonError(meta.error, 422);

  const body = JSON.stringify(meta);
  if (env.VAULTDL_CACHE) {
    ctx.waitUntil(
      env.VAULTDL_CACHE.put(cacheKey, body, { expirationTtl: CONFIG.CACHE_TTL_METADATA }).catch(() => {})
    );
  }
  return new Response(body, { headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' } });
}

// ─────────────────────────────────────────────
// /api/download
// ─────────────────────────────────────────────
async function handleDownload(url) {
  const videoUrl = url.searchParams.get('url');
  const format   = (url.searchParams.get('format') || 'mp4').toLowerCase();
  const quality  = url.searchParams.get('quality') || '720';
  const from     = url.searchParams.get('from')    || '';
  const to       = url.searchParams.get('to')      || '';
  const title    = url.searchParams.get('title')   || 'video';
  const artist   = url.searchParams.get('artist')  || '';

  if (!videoUrl)                              return jsonError('Missing url parameter', 400);
  if (!['mp4','mp3','gif'].includes(format))  return jsonError('Invalid format', 400);
  if (from && !isValidTimecode(from))         return jsonError('Invalid "from" timecode', 400);
  if (to   && !isValidTimecode(to))           return jsonError('Invalid "to" timecode',   400);
  const vErr = validateVideoUrl(videoUrl);
  if (vErr) return jsonError(vErr, 400);

  const resolved = await resolveDownloadUrl(videoUrl, { format, quality, from, to });
  if (resolved.error) return jsonError(resolved.error, 422);

  const { downloadUrl, mimeType, ext } = resolved;

  const upstream = await fetch(downloadUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': videoUrl },
  });
  if (!upstream.ok) return jsonError(`Upstream error ${upstream.status}`, 502);

  const safe  = n => sanitizeFilename(n);
  const fname = artist
    ? `${safe(artist)} - ${safe(title)}.${ext}`
    : `${safe(title)}.${ext}`;

  const headers = new Headers({
    'Content-Type': mimeType,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    'Cache-Control': `public, max-age=${CONFIG.CACHE_TTL_STREAM}`,
    'X-Content-Type-Options': 'nosniff',
  });
  const cl = upstream.headers.get('content-length');
  if (cl) headers.set('Content-Length', cl);

  return new Response(upstream.body, { status: 200, headers });
}

// ─────────────────────────────────────────────
// COBALT v10 — metadata
// ─────────────────────────────────────────────
async function fetchMetadata(videoUrl) {
  try {
    const data = await cobaltPost(videoUrl, { downloadMode: 'auto', videoQuality: '720' });
    if (!data) return fallbackMeta(videoUrl);
    if (data.status === 'error') return { error: data.error?.code || 'Could not extract video info.' };

    // cobalt may return a tunnel URL plus filename/thumbnail
    return {
      title:       data.filename?.replace(/\.[^.]+$/, '') || extractTitle(videoUrl),
      author:      '',
      thumbnail:   data.thumbnail || getThumbnailFallback(videoUrl),
      duration:    null,
      platform:    detectPlatform(videoUrl),
      originalUrl: videoUrl,
    };
  } catch (err) {
    console.error('[fetchMetadata]', err?.message);
    return fallbackMeta(videoUrl);
  }
}

// ─────────────────────────────────────────────
// COBALT v10 — resolve download URL
// ─────────────────────────────────────────────
async function resolveDownloadUrl(videoUrl, { format, quality, from, to }) {
  try {
    const opts = {
      downloadMode: format === 'mp3' ? 'audio' : 'auto',
      videoQuality: quality === '1080' ? '1080' : quality === '360' ? '360' : '720',
    };
    if (from) opts.startTime = from;
    if (to)   opts.endTime   = to;

    const data = await cobaltPost(videoUrl, opts);
    if (!data) return { error: 'Could not reach extraction service.' };
    if (data.status === 'error') return { error: data.error?.code || 'Could not resolve download URL.' };

    // cobalt v10: status can be 'tunnel', 'redirect', or 'picker'
    let downloadUrl = data.url;

    // picker: multiple streams returned (e.g. Instagram carousel)
    if (!downloadUrl && Array.isArray(data.picker)) {
      downloadUrl = data.picker[0]?.url;
    }
    if (!downloadUrl) return { error: 'No downloadable stream found.' };

    const ext     = format === 'mp3' ? 'mp3' : format === 'gif' ? 'gif' : 'mp4';
    const mimeMap = { mp3: 'audio/mpeg', gif: 'image/gif', mp4: 'video/mp4' };
    return { downloadUrl, ext, mimeType: mimeMap[ext] };
  } catch (err) {
    console.error('[resolveDownloadUrl]', err?.message);
    return { error: 'Failed to resolve download stream.' };
  }
}

// single cobalt POST helper
async function cobaltPost(videoUrl, opts) {
  const body = {
    url:           videoUrl,
    videoQuality:  opts.videoQuality  || '720',
    audioFormat:   'mp3',
    filenameStyle: 'basic',
    downloadMode:  opts.downloadMode  || 'auto',
    youtubeHLS:    false,
    ...(opts.startTime ? { startTime: opts.startTime } : {}),
    ...(opts.endTime   ? { endTime:   opts.endTime   } : {}),
  };

  const res = await fetch(`${CONFIG.COBALT_API}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error('[cobaltPost] HTTP', res.status);
    return null;
  }
  return res.json().catch(() => null);
}

// ─────────────────────────────────────────────
// RATE LIMITING via KV
// ─────────────────────────────────────────────
async function checkRateLimit(ip, env) {
  if (!env.VAULTDL_CACHE) return true;
  const key = `rl:${ip}`;
  const now = Date.now();
  try {
    const raw = await env.VAULTDL_CACHE.get(key);
    if (raw) {
      const e = JSON.parse(raw);
      if (now - e.windowStart < CONFIG.RATE_LIMIT_WINDOW_MS) {
        if (e.count >= CONFIG.RATE_LIMIT_REQUESTS) return false;
        e.count++;
        await env.VAULTDL_CACHE.put(key, JSON.stringify(e), { expirationTtl: 120 });
      } else {
        await env.VAULTDL_CACHE.put(key, JSON.stringify({ windowStart: now, count: 1 }), { expirationTtl: 120 });
      }
    } else {
      await env.VAULTDL_CACHE.put(key, JSON.stringify({ windowStart: now, count: 1 }), { expirationTtl: 120 });
    }
  } catch {}
  return true;
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function validateVideoUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!['http:','https:'].includes(u.protocol)) return 'URL must use HTTP or HTTPS.';
    const host = u.hostname.replace('www.','').toLowerCase();
    const allowed = ['youtube.com','youtu.be','tiktok.com','instagram.com'];
    if (!allowed.some(d => host.includes(d))) return 'Unsupported platform. Supported: YouTube, TikTok, Instagram.';
    return null;
  } catch { return 'Invalid URL.'; }
}

function detectPlatform(url) {
  try {
    const h = new URL(url).hostname.replace('www.','').toLowerCase();
    if (h.includes('youtube') || h.includes('youtu.be')) return 'YouTube';
    if (h.includes('tiktok'))    return 'TikTok';
    if (h.includes('instagram')) return 'Instagram';
  } catch {}
  return 'Unknown';
}

function getThumbnailFallback(videoUrl) {
  try {
    const u = new URL(videoUrl);
    const v = u.searchParams.get('v');
    if (v) return `https://img.youtube.com/vi/${v}/mqdefault.jpg`;
  } catch {}
  return '';
}

function fallbackMeta(videoUrl) {
  return {
    title: extractTitle(videoUrl), author: '', thumbnail: getThumbnailFallback(videoUrl),
    duration: null, platform: detectPlatform(videoUrl), originalUrl: videoUrl,
  };
}

function extractTitle(url) {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v) return `Video ${v}`;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'video';
  } catch { return 'video'; }
}

function sanitizeFilename(n) {
  return String(n).replace(/[<>:"/\\|?*\x00-\x1f]/g,'').replace(/\s+/g,' ').trim().substring(0,100) || 'video';
}
function isValidTimecode(t) { return /^\d{1,2}:\d{2}(:\d{2})?$/.test(t.trim()); }
function json(obj, status=200)           { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }); }
function jsonError(msg, status=400, extra={}) { return json({ error: msg }, status); }
function addCors(r) {
  const res = new Response(r.body, r);
  res.headers.set('Access-Control-Allow-Origin',  CONFIG.CORS_ORIGIN);
  res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  res.headers.set('X-Powered-By', 'VaultDL');
  return res;
}
