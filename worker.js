/**
 * VaultDL – Cloudflare Worker (worker.js)
 *
 * Routes:
 *   GET /api/info?url=...      → return video metadata JSON
 *   GET /api/download?url=...  → proxy/stream the media file
 *
 * Supports: YouTube, TikTok, Instagram
 * Uses cobalt.tools open API as the extraction backend
 * (self-hostable, no API key required for basic usage)
 */

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────
const CONFIG = {
  // Cobalt API instance — use the official public instance or self-host
  COBALT_API: 'https://cobalt.tools/api',

  // Rate limiting: max requests per window per IP
  RATE_LIMIT_REQUESTS: 20,
  RATE_LIMIT_WINDOW_MS: 60_000, // 1 minute

  // Allowed origins (set to your domain in production)
  CORS_ORIGIN: '*',

  // Max video duration (seconds) to prevent abuse
  MAX_DURATION_SECS: 7200, // 2 hours

  // Cache TTL for metadata
  CACHE_TTL_METADATA: 300,  // 5 minutes
  CACHE_TTL_STREAM:   30,   // 30 seconds
};

// ─────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Only allow GET
    if (request.method !== 'GET') {
      return corsResponse(jsonError('Method not allowed', 405));
    }

    // Rate limiting (using Cloudflare's CF-Connecting-IP)
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitResult = await checkRateLimit(ip, env);
    if (!rateLimitResult.ok) {
      return corsResponse(jsonError('Rate limit exceeded. Please wait a minute.', 429, {
        'Retry-After': '60',
        'X-RateLimit-Limit':     String(CONFIG.RATE_LIMIT_REQUESTS),
        'X-RateLimit-Remaining': '0',
      }));
    }

    // Route
    const path = url.pathname;

    try {
      if (path === '/api/info' || path === '/api/info/') {
        return corsResponse(await handleInfo(request, url, env, ctx));
      }
      if (path === '/api/download' || path === '/api/download/') {
        return corsResponse(await handleDownload(request, url, env, ctx));
      }
      if (path === '/api/health') {
        return corsResponse(new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
    } catch (err) {
      console.error('[VaultDL Worker Error]', err);
      return corsResponse(jsonError('Internal server error', 500));
    }

    return corsResponse(jsonError('Not found', 404));
  },
};

// ─────────────────────────────────────────────
// HANDLER: /api/info
// Returns video metadata (title, thumbnail, duration, author)
// ─────────────────────────────────────────────
async function handleInfo(request, url, env, ctx) {
  const videoUrl = url.searchParams.get('url');
  if (!videoUrl) return jsonError('Missing url parameter', 400);

  const validation = validateVideoUrl(videoUrl);
  if (!validation.ok) return jsonError(validation.error, 400);

  // Try cache first
  const cacheKey = `info:${videoUrl}`;
  if (env.VAULTDL_CACHE) {
    const cached = await env.VAULTDL_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }
  }

  // Fetch metadata via cobalt
  const meta = await fetchMetadata(videoUrl);
  if (meta.error) return jsonError(meta.error, 422);

  const body = JSON.stringify(meta);

  // Store in KV cache (fire-and-forget)
  if (env.VAULTDL_CACHE) {
    ctx.waitUntil(
      env.VAULTDL_CACHE.put(cacheKey, body, { expirationTtl: CONFIG.CACHE_TTL_METADATA })
    );
  }

  return new Response(body, {
    headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
  });
}

// ─────────────────────────────────────────────
// HANDLER: /api/download
// Resolves a download URL and proxies the stream
// ─────────────────────────────────────────────
async function handleDownload(request, url, env, ctx) {
  const videoUrl = url.searchParams.get('url');
  const format   = (url.searchParams.get('format')  || 'mp4').toLowerCase();
  const quality  = url.searchParams.get('quality')  || '720';
  const from     = url.searchParams.get('from')     || '';
  const to       = url.searchParams.get('to')       || '';
  const title    = url.searchParams.get('title')    || 'video';
  const artist   = url.searchParams.get('artist')   || '';

  if (!videoUrl) return jsonError('Missing url parameter', 400);
  if (!['mp4','mp3','gif'].includes(format)) return jsonError('Invalid format', 400);
  if (!['360','720','1080'].includes(quality) && format === 'mp4') return jsonError('Invalid quality', 400);

  const validation = validateVideoUrl(videoUrl);
  if (!validation.ok) return jsonError(validation.error, 400);

  // Validate trim times
  if (from && !isValidTimecode(from)) return jsonError('Invalid "from" timecode', 400);
  if (to   && !isValidTimecode(to))   return jsonError('Invalid "to" timecode',   400);

  // Resolve actual download URL via cobalt
  const resolved = await resolveDownloadUrl(videoUrl, { format, quality, from, to });
  if (resolved.error) return jsonError(resolved.error, 422);

  const { downloadUrl, mimeType, ext } = resolved;

  // Stream the file back to the client
  const upstream = await fetch(downloadUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; VaultDL/1.0)',
      'Referer': videoUrl,
    },
    cf: {
      cacheEverything: false,
      scrapeShield: false,
    },
  });

  if (!upstream.ok) {
    return jsonError(`Upstream returned ${upstream.status}`, 502);
  }

  const safeTitle  = sanitizeFilename(title);
  const safeArtist = sanitizeFilename(artist);
  const filename   = safeArtist
    ? `${safeArtist} - ${safeTitle}.${ext}`
    : `${safeTitle}.${ext}`;

  const headers = new Headers({
    'Content-Type': mimeType,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': `public, max-age=${CONFIG.CACHE_TTL_STREAM}`,
  });

  // Forward content-length if present
  const cl = upstream.headers.get('content-length');
  if (cl) headers.set('Content-Length', cl);

  return new Response(upstream.body, {
    status: 200,
    headers,
  });
}

// ─────────────────────────────────────────────
// COBALT METADATA FETCHER
// Uses cobalt.tools JSON API
// ─────────────────────────────────────────────
async function fetchMetadata(videoUrl) {
  try {
    const platform = detectPlatform(videoUrl);

    // cobalt /api/json endpoint
    const res = await fetch(`${CONFIG.COBALT_API}/json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        url: videoUrl,
        vQuality: '720',
        aFormat: 'mp3',
        filenamePattern: 'basic',
        isAudioOnly: false,
        isNoTTWatermark: true,
        isTTFullAudio: false,
        isAudioMuted: false,
        disableMetadata: false,
        dubLang: false,
        twitterGif: false,
      }),
    });

    const data = await res.json();

    if (data.status === 'error') {
      return { error: data.text || 'Could not extract video info.' };
    }

    // Extract metadata from cobalt response
    const meta = {
      title:     data.metadata?.title  || data.filename || extractTitleFromUrl(videoUrl),
      author:    data.metadata?.author || '',
      thumbnail: data.thumbnail || '',
      duration:  data.metadata?.duration || null,
      platform,
      originalUrl: videoUrl,
    };

    return meta;
  } catch (err) {
    console.error('[fetchMetadata]', err);
    // Fallback: return basic info parsed from URL
    return {
      title:     extractTitleFromUrl(videoUrl),
      author:    '',
      thumbnail: '',
      duration:  null,
      platform:  detectPlatform(videoUrl),
      originalUrl: videoUrl,
    };
  }
}

// ─────────────────────────────────────────────
// COBALT DOWNLOAD RESOLVER
// ─────────────────────────────────────────────
async function resolveDownloadUrl(videoUrl, options) {
  const { format, quality, from, to } = options;
  const isAudio = format === 'mp3';
  const isGif   = format === 'gif';

  try {
    const body = {
      url: videoUrl,
      vQuality: quality === '1080' ? '1080' : quality === '360' ? '360' : '720',
      aFormat: 'mp3',
      filenamePattern: 'basic',
      isAudioOnly: isAudio,
      isNoTTWatermark: true,
      isTTFullAudio: false,
      isAudioMuted: false,
      disableMetadata: false,
      dubLang: false,
      twitterGif: isGif,
    };

    // Add trim if provided (cobalt supports start/end in seconds via some forks)
    if (from) body.startTime = timecodeToSeconds(from);
    if (to)   body.endTime   = timecodeToSeconds(to);

    const res = await fetch(`${CONFIG.COBALT_API}/json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (data.status === 'error') {
      return { error: data.text || 'Could not resolve download URL.' };
    }

    // cobalt returns a direct URL or a picker
    let downloadUrl = data.url;
    if (!downloadUrl && data.picker) {
      // Picker: take first entry matching requested quality
      downloadUrl = data.picker[0]?.url;
    }

    if (!downloadUrl) {
      return { error: 'No downloadable stream found.' };
    }

    const ext = isAudio ? 'mp3' : isGif ? 'gif' : 'mp4';
    const mimeMap = { mp3: 'audio/mpeg', gif: 'image/gif', mp4: 'video/mp4' };

    return {
      downloadUrl,
      ext,
      mimeType: mimeMap[ext] || 'application/octet-stream',
    };
  } catch (err) {
    console.error('[resolveDownloadUrl]', err);
    return { error: 'Failed to resolve download stream.' };
  }
}

// ─────────────────────────────────────────────
// RATE LIMITING  (in-memory via Durable Objects
// or simplified via KV — uses KV here)
// ─────────────────────────────────────────────
async function checkRateLimit(ip, env) {
  // If no KV namespace is bound, skip rate limiting
  if (!env.VAULTDL_CACHE) return { ok: true };

  const key = `rl:${ip}`;
  const now = Date.now();

  try {
    const raw = await env.VAULTDL_CACHE.get(key);
    if (raw) {
      const entry = JSON.parse(raw);
      if (now - entry.windowStart < CONFIG.RATE_LIMIT_WINDOW_MS) {
        if (entry.count >= CONFIG.RATE_LIMIT_REQUESTS) {
          return { ok: false };
        }
        entry.count++;
        await env.VAULTDL_CACHE.put(key, JSON.stringify(entry), { expirationTtl: 120 });
      } else {
        // New window
        await env.VAULTDL_CACHE.put(key, JSON.stringify({ windowStart: now, count: 1 }), { expirationTtl: 120 });
      }
    } else {
      await env.VAULTDL_CACHE.put(key, JSON.stringify({ windowStart: now, count: 1 }), { expirationTtl: 120 });
    }
    return { ok: true };
  } catch {
    return { ok: true }; // fail open
  }
}

// ─────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────

function validateVideoUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!['http:', 'https:'].includes(u.protocol)) {
      return { ok: false, error: 'URL must use HTTP or HTTPS.' };
    }
    const host = u.hostname.replace('www.', '').toLowerCase();
    const allowed = ['youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com'];
    if (!allowed.some(d => host.includes(d))) {
      return { ok: false, error: 'Unsupported platform. Supported: YouTube, TikTok, Instagram.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }
}

function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '').toLowerCase();
    if (host.includes('youtube') || host.includes('youtu.be')) return 'YouTube';
    if (host.includes('tiktok'))    return 'TikTok';
    if (host.includes('instagram')) return 'Instagram';
    return 'Unknown';
  } catch { return 'Unknown'; }
}

function extractTitleFromUrl(url) {
  try {
    const u = new URL(url);
    // YouTube video ID
    const v = u.searchParams.get('v');
    if (v) return `YouTube video ${v}`;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'video';
  } catch { return 'video'; }
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100) || 'video';
}

function isValidTimecode(t) {
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(t.trim());
}

function timecodeToSeconds(t) {
  const parts = t.trim().split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function jsonError(msg, status = 400, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function corsResponse(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin',  CONFIG.CORS_ORIGIN);
  r.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  r.headers.set('X-Powered-By', 'VaultDL/Cloudflare-Workers');
  return r;
}
