'use strict';

const fs = require('fs');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const { tokenFile, ROOT } = require('./paths');
const { TOKEN_HOST, deviceId, deviceInfo, discoHeaders } = require('./max-constants');

const SESSION_PATH = tokenFile();

function loadSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveSession(patch) {
  const prev = loadSession();
  const next = {
    ...prev,
    ...patch,
    updated: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function httpsJson(url, { method = 'GET', headers = {}, body = null, cookies = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...headers };
    if (cookies) h.Cookie = cookies;
    const req = https.request(u, { method, headers: h, timeout: 45000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 240)}`));
          return;
        }
        try {
          resolve(JSON.parse(data || '{}'));
        } catch {
          reject(new Error('Response was not JSON'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function cookieHeader(st, extra = '') {
  const parts = [];
  if (st) parts.push(`st=${st}`);
  if (extra) parts.push(extra);
  return parts.join('; ');
}

async function fetchAnonymousSt(deviceUuid, installId) {
  const dev = deviceUuid || deviceId();
  const url = `https://${TOKEN_HOST}/token?realm=bolt&deviceId=${encodeURIComponent(dev)}`;
  const headers = discoHeaders({
    'x-device-info': deviceInfo(dev, installId),
  });
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, { method: 'GET', headers, timeout: 45000 }, (res) => {
      const st = (res.headers['set-cookie'] || [])
        .map((c) => c.split(';')[0])
        .find((c) => c.startsWith('st='));
      if (!st) {
        reject(new Error('Could not obtain anonymous st cookie from HBO Max'));
        return;
      }
      resolve(st.replace(/^st=/, ''));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Token request timeout')));
    req.end();
  });
}

async function bootstrap(st, deviceUuid, installId) {
  const url = `https://${TOKEN_HOST}/session-context/headwaiter/v1/bootstrap`;
  const headers = discoHeaders({
    'Content-Type': 'application/json',
    'x-device-info': deviceInfo(deviceUuid, installId),
  });
  const json = await httpsJson(url, {
    method: 'POST',
    headers,
    body: '{}',
    cookies: cookieHeader(st),
  });
  const r = json.routing || json;
  const tenant = r.tenant || 'beam';
  const homeMarket = r.homeMarket || 'emea';
  const env = r.env || 'prd';
  const domain = r.domain || 'api.hbomax.com';
  const apiHost = `default.${tenant}-${homeMarket}.${env}.${domain}`;
  return { apiHost, routing: r, bootstrap: json };
}

function formatEndpointBase(baseUrl, routing) {
  let url = String(baseUrl || '');
  const r = routing || {};
  for (const [key, val] of Object.entries(r)) {
    url = url.split(`{${key}}`).join(val);
  }
  url = url.replace('{env}', r.env || 'prd');
  url = url.replace('{domain}', r.domain || 'api.hbomax.com');
  url = url.replace('{tenant}', r.tenant || 'beam');
  url = url.replace('{homeMarket}', r.homeMarket || 'emea');
  return url;
}

/** Resolve full URL from HBO bootstrap (auth vs cms use different apiGroups). */
function resolveEndpoint(bootstrapJson, path) {
  const config = bootstrapJson || {};
  const routing = config.routing || {};
  const endpoints = config.endpoints || [];
  const groups = config.apiGroups || {};
  const want = String(path || '');
  let best = null;

  for (const row of endpoints) {
    const p = row.path || '';
    if (!p) continue;
    const exact = want.toLowerCase() === p.toLowerCase();
    const prefix = want.startsWith(p);
    if (!exact && !prefix) continue;
    if (!best || p.length > best.path.length) best = row;
  }
  if (!best) return null;
  const group = groups[best.apiGroup];
  if (!group?.baseUrl) return null;
  const base = formatEndpointBase(group.baseUrl, routing);
  return `${base}${want}`;
}

function sessionHeaders(session) {
  const token = session.accessToken || session.token;
  const headers = discoHeaders({
    'x-device-info': deviceInfo(session.deviceUuid, session.installId),
  });
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session.sessionState) headers['x-wbd-session-state'] = session.sessionState;
  return headers;
}

function sessionCookies(session) {
  return cookieHeader(session.st, session.extraCookies || '');
}

function ensureDeviceIds(session) {
  const patch = {};
  if (!session.deviceUuid) patch.deviceUuid = deviceId();
  if (!session.installId) patch.installId = crypto.randomUUID();
  return Object.keys(patch).length ? { ...session, ...patch } : session;
}

function decodeJwtPayload(token) {
  try {
    const raw = String(token || '').trim().replace(/^Bearer\s+/i, '');
    const part = raw.split('.')[1];
    if (!part) return null;
    return JSON.parse(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
  } catch {
    return null;
  }
}

function tokenIsAnonymous(token) {
  const payload = decodeJwtPayload(token);
  return payload?.anonymous === true;
}

module.exports = {
  loadSession,
  saveSession,
  fetchAnonymousSt,
  bootstrap,
  sessionHeaders,
  sessionCookies,
  ensureDeviceIds,
  decodeJwtPayload,
  tokenIsAnonymous,
  resolveEndpoint,
  formatEndpointBase,
  httpsJson,
  ROOT,
};
