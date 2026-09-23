'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { proxyCandidates, apiProxyCandidates, agentForSpec, isProxyTransportError } = require('./proxy-request');
const { waitForProxyBeforeBrowser } = require('./proxy-wait');
const {
  loadSession,
  saveSession,
  bootstrap,
  sessionHeaders,
  sessionCookies,
  ensureDeviceIds,
  fetchAnonymousSt,
  tokenIsAnonymous,
} = require('./max-session');
const { signInViaBrowser } = require('./max-browser-auth');
const { signInViaDeviceLink, usersMeIsSubscriber } = require('./max-device-login');
const { SITE_ORIGIN } = require('./max-constants');

const { cmsSearch: cmsSearchApi } = require('./max-cms');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function requestJsonOnce(url, { method = 'GET', headers = {}, body = null, cookies = '', agent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...headers };
    if (cookies) h.Cookie = cookies;
    const req = https.request(u, {
      method,
      headers: h,
      agent,
      timeout: 45000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 240)}`);
          err.status = res.statusCode;
          reject(err);
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

async function requestJson(url, opts = {}) {
  let lastErr;
  for (const spec of apiProxyCandidates()) {
    try {
      return await requestJsonOnce(url, {
        ...opts,
        agent: agentForSpec(spec, 45000),
      });
    } catch (err) {
      lastErr = err;
      if (err.status && err.status !== 502 && err.status !== 503) throw err;
      if (!isProxyTransportError(err) && !err.status) throw err;
    }
  }
  try {
    return await requestJsonOnce(url, { ...opts, agent: undefined });
  } catch (err) {
    throw lastErr || err;
  }
}

function tokenLooksValid(session) {
  if (!session.st || !session.apiHost) return false;
  const t = session.accessToken || session.token || session.st;
  if (!t) return false;
  try {
    const part = t.split('.')[1];
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (payload.exp && payload.exp * 1000 < Date.now() + 60000) return false;
    if (payload.anonymous === true) return false;
    return true;
  } catch {
    return !!t;
  }
}

async function sessionReadyForPlayback(session) {
  const t = session.accessToken || session.token || session.st;
  if (t && !tokenIsAnonymous(t)) return true;
  return usersMeIsSubscriber(session);
}

async function authenticate(onStatus) {
  const status = onStatus || (() => {});
  loadEnv();

  const proxies = proxyCandidates();
  const proxySpec = proxies[0] || String(process.env.TNT_PROXY || '').trim();
  if (!proxySpec) throw new Error('TNT_PROXY not set in .env');

  let session = ensureDeviceIds(loadSession());
  if (tokenLooksValid(session)) {
    const subscribed = await usersMeIsSubscriber(session);
    if (subscribed) {
      status('Using saved HBO Max session (tnt-token.json)');
      return session;
    }
    status('Saved HBO Max token is not a subscribed account — signing in again...');
  }

  if (process.env.TNT_ALLOW_ANONYMOUS === '1' && session.st && session.apiHost) {
    status('Using guest HBO Max session (browse/search only — set TNT_DEVICE_LOGIN=1 for playback)');
    return session;
  }

  const hadAnonymous = session.st && tokenIsAnonymous(session.accessToken || session.st);
  if (hadAnonymous) {
    status('Saved session is guest-only (search works, playback needs a real login). Re-authenticating...');
  }

  if (process.env.TNT_DEVICE_LOGIN === '1' || (hadAnonymous && process.env.TNT_BROWSER_LOGIN !== '1')) {
    status('HBO Max device link login (recommended)...');
    return signInViaDeviceLink({ onStatus: status });
  }

  const email = String(process.env.TNT_EMAIL || '').trim();
  const password = String(process.env.TNT_PASSWORD || '');
  if (!email || !password) {
    if (process.env.TNT_SKIP_BROWSER === '1') {
      throw new Error('Set TNT_EMAIL/TNT_PASSWORD or use TNT_DEVICE_LOGIN=1 for play.hbomax.com/link login');
    }
    status('No TNT_EMAIL in .env — using device link login');
    return signInViaDeviceLink({ onStatus: status });
  }

  const browserProxy = process.env.TNT_BROWSER_VIA_TUNNEL === '1'
    ? (await waitForProxyBeforeBrowser(status))
    : (String(process.env.TNT_PROXY || '').trim() || proxySpec);
  if (process.env.TNT_BROWSER_VIA_TUNNEL !== '1') {
    status(`Browser login via UK proxy ${browserProxy.split(':')[0]} (set TNT_BROWSER_VIA_TUNNEL=1 to use Clash tunnel)`);
  }

  if (process.env.TNT_SKIP_BROWSER === '1') {
    throw new Error('No valid tnt-token.json and TNT_SKIP_BROWSER=1');
  }

  status('Signing in via browser (UK HBO Max / TNT Sports)...');
  session = await signInViaBrowser({
    email,
    password,
    proxySpec: browserProxy,
    onStatus: status,
    headless: process.env.TNT_BROWSER_HEADLESS === '1',
  });
  if (!(await sessionReadyForPlayback(session))) {
    status('Browser login did not yield a subscribed token — try device link (TNT_DEVICE_LOGIN=1)');
    return signInViaDeviceLink({ onStatus: status });
  }
  return session;
}

async function fetchSearch(query, session, onStatus) {
  return cmsSearchApi(session, query, { onStatus });
}

const { fetchMainNavEntries, buildBrowseCategories } = require('./max-nav');

let categories = [];
let categoryGroups = null;

async function loadCategories(session, onStatus) {
  const status = onStatus || (() => {});
  try {
    const nav = await fetchMainNavEntries(session, { onStatus: status });
    categories = buildBrowseCategories(nav);
    categoryGroups = null;
    status(`Loaded ${categories.length} menu entries (HBO Max web-menu-bar)`);
  } catch (e) {
    status(`Menu load failed (${e.message}) — using fallback`);
    categories = buildBrowseCategories([
      { label: 'Home', route: '/home' },
      { label: 'TNT Sports', route: '/sports' },
      { label: 'Series', route: '/series' },
      { label: 'Movies', route: '/movies' },
      { label: 'HBO', route: '/channel/c0d1f27a-e2f8-4b3c-bf3c-ed0c4e258093' },
    ]);
  }
}

function getCategories() {
  return categories.length ? categories : buildBrowseCategories([]);
}

function getCategoryGroups() {
  return categoryGroups;
}

function formatLocalTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London' });
  } catch {
    return String(iso);
  }
}

module.exports = {
  loadEnv,
  authenticate,
  sessionReadyForPlayback,
  loadCategories,
  getCategories,
  getCategoryGroups,
  fetchSearch,
  formatLocalTime,
  requestJson,
  sessionHeaders,
  sessionCookies,
  loadSession,
  saveSession,
  SITE_ORIGIN,
};
