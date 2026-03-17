/* ─────────────────────────────────────────────
   VaultDL – app.js
   Frontend application logic
───────────────────────────────────────────── */

// ── CONFIG ──
// Change this to your deployed Cloudflare Worker URL
const API_BASE = '/api'; // proxied via same domain, or set to full worker URL

// ── DOM REFS ──
const urlInput       = document.getElementById('video-url');
const clearBtn       = document.getElementById('clear-btn');
const fetchBtn       = document.getElementById('fetch-btn');
const errorMsg       = document.getElementById('error-msg');
const results        = document.getElementById('results');
const thumbEl        = document.getElementById('thumb');
const durationBadge  = document.getElementById('duration-badge');
const platformChip   = document.getElementById('platform-chip');
const editTitle      = document.getElementById('edit-title');
const editArtist     = document.getElementById('edit-artist');
const formatGroup    = document.getElementById('format-group');
const qualityGroup   = document.getElementById('quality-group');
const qualityWrap    = document.getElementById('quality-group-wrap');
const trimFrom       = document.getElementById('trim-from');
const trimTo         = document.getElementById('trim-to');
const downloadBtn    = document.getElementById('download-btn');
const dlLabel        = document.getElementById('dl-label');
const progressWrap   = document.getElementById('progress-wrap');
const progressBar    = document.getElementById('progress-bar');
const progressText   = document.getElementById('progress-text');

// ── STATE ──
let state = {
  videoData: null,
  format: 'mp4',
  quality: '720',
};

// ── URL INPUT EVENTS ──
urlInput.addEventListener('input', () => {
  clearBtn.style.display = urlInput.value ? 'block' : 'none';
  clearError();
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchVideo();
});

clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  clearBtn.style.display = 'none';
  hideResults();
  clearError();
  urlInput.focus();
});

// ── FETCH BTN ──
fetchBtn.addEventListener('click', fetchVideo);

// ── FORMAT PILLS ──
formatGroup.addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  setActivePill(formatGroup, pill);
  state.format = pill.dataset.value;
  updateDownloadLabel();
  // hide quality for MP3 / GIF
  qualityWrap.style.display = (state.format === 'mp4') ? '' : 'none';
});

// ── QUALITY PILLS ──
qualityGroup.addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  setActivePill(qualityGroup, pill);
  state.quality = pill.dataset.value;
  updateDownloadLabel();
});

// ── DOWNLOAD BTN ──
downloadBtn.addEventListener('click', startDownload);

// ── HELPERS ──
function setActivePill(group, active) {
  group.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  active.classList.add('active');
}

function showError(msg) {
  errorMsg.textContent = msg;
}
function clearError() {
  errorMsg.textContent = '';
}

function setFetching(loading) {
  fetchBtn.disabled = loading;
  fetchBtn.classList.toggle('loading', loading);
}

function hideResults() {
  results.hidden = true;
  state.videoData = null;
}

function updateDownloadLabel() {
  const fmt = state.format.toUpperCase();
  if (state.format === 'mp3') {
    dlLabel.textContent = `Download ${fmt}`;
  } else if (state.format === 'gif') {
    dlLabel.textContent = `Download ${fmt}`;
  } else {
    dlLabel.textContent = `Download ${fmt} · ${state.quality}p`;
  }
}

function detectPlatform(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '');
    if (host.includes('youtube') || host.includes('youtu.be')) return 'YouTube';
    if (host.includes('tiktok'))    return 'TikTok';
    if (host.includes('instagram')) return 'Instagram';
    return 'Unknown';
  } catch { return 'Unknown'; }
}

const PLATFORM_ICONS = {
  YouTube:  '▶',
  TikTok:   '♪',
  Instagram:'◈',
  Unknown:  '🌐',
};

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function validateUrl(url) {
  if (!url || url.trim() === '') return 'Please enter a video URL.';
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return 'URL must start with http:// or https://';
    const supported = ['youtube.com','youtu.be','tiktok.com','instagram.com'];
    const host = u.hostname.replace('www.','');
    if (!supported.some(s => host.includes(s))) {
      return 'Unsupported platform. Supported: YouTube, TikTok, Instagram.';
    }
    return null;
  } catch {
    return 'Invalid URL format.';
  }
}

// ── FETCH VIDEO METADATA ──
async function fetchVideo() {
  const url = urlInput.value.trim();
  const validErr = validateUrl(url);
  if (validErr) { showError(validErr); return; }
  clearError();
  setFetching(true);
  hideResults();

  try {
    const res = await fetch(`${API_BASE}/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok || data.error) {
      showError(data.error || `Error ${res.status}: Could not fetch video info.`);
      return;
    }

    state.videoData = data;
    renderResults(data, url);
  } catch (err) {
    showError('Network error — please check your connection and try again.');
    console.error(err);
  } finally {
    setFetching(false);
  }
}

// ── RENDER RESULTS ──
function renderResults(data, url) {
  // Thumbnail
  if (data.thumbnail) {
    thumbEl.src = data.thumbnail;
    thumbEl.alt = data.title || 'Video thumbnail';
  } else {
    thumbEl.src = `https://placehold.co/280x157/111114/2a2a32?text=No+Preview`;
  }

  // Duration
  durationBadge.textContent = formatDuration(data.duration) || '';

  // Platform chip
  const platform = detectPlatform(url);
  platformChip.textContent = `${PLATFORM_ICONS[platform] || '🌐'} ${platform}`;

  // Metadata fields
  editTitle.value  = data.title  || '';
  editArtist.value = data.author || data.uploader || '';

  // Reset format/quality state
  state.format  = 'mp4';
  state.quality = '720';
  setActivePill(formatGroup, formatGroup.querySelector('[data-value="mp4"]'));
  setActivePill(qualityGroup, qualityGroup.querySelector('[data-value="720"]'));
  qualityWrap.style.display = '';

  // Clear trim
  trimFrom.value = '';
  trimTo.value   = '';

  updateDownloadLabel();

  // Show results
  results.hidden = false;
  progressWrap.hidden = true;
  progressBar.style.width = '0%';
}

// ── DOWNLOAD ──
async function startDownload() {
  if (!state.videoData) return;

  const url      = urlInput.value.trim();
  const format   = state.format;
  const quality  = state.quality;
  const title    = editTitle.value.trim()  || state.videoData.title  || 'video';
  const artist   = editArtist.value.trim() || state.videoData.author || '';
  const from     = trimFrom.value.trim();
  const to       = trimTo.value.trim();

  // Validate trim times
  if (from && !isValidTime(from)) { showError('Invalid "From" time. Use format m:ss or h:mm:ss'); return; }
  if (to   && !isValidTime(to))   { showError('Invalid "To" time. Use format m:ss or h:mm:ss');   return; }
  clearError();

  // Build query
  const params = new URLSearchParams({ url, format, quality, title, artist });
  if (from) params.set('from', from);
  if (to)   params.set('to', to);

  showProgress('Preparing your download…', 5);

  try {
    const res = await fetch(`${API_BASE}/download?${params.toString()}`);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      hideProgress();
      showError(err.error || `Download failed (${res.status}). Try again.`);
      return;
    }

    showProgress('Receiving file…', 60);

    // Stream to blob
    const contentDisp = res.headers.get('Content-Disposition') || '';
    const filenameMatch = contentDisp.match(/filename\*?=["']?(?:UTF-8'')?([^"';\n]+)/i);
    const ext = format === 'mp3' ? 'mp3' : format === 'gif' ? 'gif' : 'mp4';
    const filename = filenameMatch
      ? decodeURIComponent(filenameMatch[1])
      : `${sanitizeFilename(title)}.${ext}`;

    const blob = await res.blob();
    showProgress('Starting download…', 95);

    triggerDownload(blob, filename);
    showProgress('Done!', 100);

    setTimeout(hideProgress, 1800);
  } catch (err) {
    hideProgress();
    showError('Download failed — network error.');
    console.error(err);
  }
}

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}

function showProgress(text, pct) {
  progressWrap.hidden = false;
  progressText.textContent = text;
  progressBar.style.width  = pct + '%';
}
function hideProgress() {
  progressWrap.hidden = true;
  progressBar.style.width = '0%';
}

function isValidTime(t) {
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(t.trim());
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9_\-\s]/gi, '').replace(/\s+/g, '_').substring(0, 80) || 'video';
}

// ── PASTE SHORTCUT ──
// Auto-fetch on paste into URL input if it looks like a valid URL
urlInput.addEventListener('paste', (e) => {
  setTimeout(() => {
    const v = urlInput.value.trim();
    if (v.startsWith('http') && !validateUrl(v)) {
      fetchVideo();
    }
  }, 50);
});

// ── INIT ──
updateDownloadLabel();
