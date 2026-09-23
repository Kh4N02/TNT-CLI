'use strict';

/** host:port:user:pass (preferred) or http://user:pass@host:port → proxy URL for HttpsProxyAgent */
function parseCustomProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!u.hostname || !u.port) return null;
      if (!u.username || !u.password) return null;
      return s;
    } catch {
      return null;
    }
  }

  const parts = s.split(':');
  if (parts.length < 2) return null;

  const host = parts[0];
  const port = parts[1];
  if (!host || !port) return null;

  if (parts.length === 3) return null;

  if (parts.length >= 4) {
    const user = parts[2];
    const pass = parts.slice(3).join(':');
    if (!user || !pass) return null;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  return `http://${host}:${port}`;
}

function validateTntProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Set TNT_PROXY in .env';
  return null;
}

function proxyFormatHint(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Set TNT_PROXY=host:port:user:pass in .env';
  if (/^https?:\/\//i.test(s)) {
    return 'TNT_PROXY: use host:port:user:pass (not a masked http:// URL with ***)';
  }
  const n = s.split(':').length;
  if (n === 3) {
    return 'TNT_PROXY is missing the password — use host:port:user:pass (four parts)';
  }
  return 'TNT_PROXY format: host:port:user:pass';
}

module.exports = { parseCustomProxy, proxyFormatHint, validateTntProxy };
