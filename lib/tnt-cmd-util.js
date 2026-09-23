'use strict';

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function sanitizeSaveName(title) {
  return String(title || '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * HBO Max CDN: playback returns dash.mpd?manifest-params=… (720p-capped ladder).
 * Full UHD/1080p ladder is at …/packager-mp4-cenc/main.mpd (no query).
 */
function formatMaxManifestUrl(manifestUrl) {
  if (process.env.TNT_MPD_RAW === '1') return String(manifestUrl || '').trim();

  const raw = String(manifestUrl || '').trim();
  if (!raw) return raw;

  try {
    const u = new URL(raw);
    if (/\/dash\.mpd$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/dash\.mpd$/i, '/main.mpd');
      u.search = '';
      u.hash = '';
      return u.toString();
    }
    if (/\/main\.mpd$/i.test(u.pathname)) {
      u.search = '';
      u.hash = '';
      return u.toString();
    }
    return raw;
  } catch {
    return raw.replace(/\/dash\.mpd(?:\?[^#]*)?(?:#.*)?$/i, '/main.mpd');
  }
}

module.exports = {
  quoteCmdArg,
  sanitizeSaveName,
  formatMaxManifestUrl,
};
