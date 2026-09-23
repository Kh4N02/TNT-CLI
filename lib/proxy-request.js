'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { vendor } = require('./paths');
const { parseCustomProxy } = require(vendor('proxy-parse'));

function envProxy(key) {
  return String(process.env[`TNT_${key}`] || '').trim();
}

function proxySpecsOrdered(order) {
  const primary = envProxy('PROXY');
  const tunnel = envProxy('PROXY_TUNNEL');
  const fallback = envProxy('PROXY_FALLBACK');
  const seen = new Set();
  const out = [];
  for (const p of order) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** HBO Max API: UK proxy first; tunnel only if TNT_API_VIA_TUNNEL=1. */
function apiProxyCandidates() {
  const primary = envProxy('PROXY');
  const tunnel = envProxy('PROXY_TUNNEL');
  const fallback = envProxy('PROXY_FALLBACK');
  if (process.env.TNT_API_VIA_TUNNEL === '1') {
    return proxySpecsOrdered([tunnel, primary, fallback]);
  }
  return proxySpecsOrdered([primary, tunnel, fallback]);
}

function proxyCandidates() {
  return apiProxyCandidates();
}

/** N_m3u8DL-RE proxy order (see .env). */
function downloadProxyCandidates() {
  const tunnel = envProxy('PROXY_TUNNEL');
  const primary = envProxy('PROXY');
  const fallback = envProxy('PROXY_FALLBACK');

  if (tunnel) {
    if (process.env.TNT_DOWNLOAD_USE_DIRECT === '1' && primary) {
      return proxySpecsOrdered([tunnel, primary, fallback]);
    }
    return proxySpecsOrdered([tunnel, primary, fallback]);
  }

  if (process.env.TNT_DOWNLOAD_USE_DIRECT === '1' && primary) {
    return proxySpecsOrdered([primary, fallback]);
  }

  return proxySpecsOrdered([primary, fallback]);
}

function parseProxyForPlaywright(spec) {
  const url = parseCustomProxy(spec);
  if (!url) return null;
  const u = new URL(url);
  const proxy = { server: `${u.protocol}//${u.hostname}:${u.port}` };
  if (u.username) proxy.username = decodeURIComponent(u.username);
  if (u.password) proxy.password = decodeURIComponent(u.password);
  return proxy;
}

function resolvePlaywrightProxy({ preferTunnel = false } = {}) {
  const primary = envProxy('PROXY');
  const tunnel = envProxy('PROXY_TUNNEL');
  const fallback = envProxy('PROXY_FALLBACK');
  const order = preferTunnel
    ? [tunnel, primary, fallback]
    : [primary, fallback, tunnel];
  for (const spec of order) {
    const proxy = parseProxyForPlaywright(spec);
    if (proxy) return proxy;
  }
  return undefined;
}

function proxyDisplayLabel(spec) {
  const s = String(spec || '').trim();
  if (!s) return '';
  const parts = s.split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  try {
    const u = new URL(s);
    return `${u.hostname}:${u.port}`;
  } catch {
    return s;
  }
}

function agentForSpec(spec, timeoutMs = 20000) {
  const url = parseCustomProxy(spec);
  return url ? new HttpsProxyAgent(url, { timeout: timeoutMs }) : undefined;
}

function probeProxyConnect(spec, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const proxyUrl = parseCustomProxy(spec);
    if (!proxyUrl) {
      resolve({ ok: false, error: 'invalid proxy spec' });
      return;
    }
    const agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs });
    const req = https.get('https://api.ipify.org?format=json', { agent, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

function downloadProxyUrl() {
  if (process.env.TNT_DOWNLOAD_PROXY === '0') return null;

  const explicit = String(process.env.TNT_DOWNLOAD_PROXY || '').trim();
  if (explicit && explicit !== '0') {
    const parsed = parseCustomProxy(explicit);
    if (parsed) return parsed;
  }

  for (const spec of downloadProxyCandidates()) {
    const parsed = parseCustomProxy(spec);
    if (parsed) return parsed;
  }
  return null;
}

async function resolveDownloadProxyUrl(preferredSpec = null) {
  if (process.env.TNT_DOWNLOAD_PROXY === '0') return null;

  const explicit = String(process.env.TNT_DOWNLOAD_PROXY || '').trim();
  if (explicit && explicit !== '0') {
    const parsed = parseCustomProxy(explicit);
    if (parsed) return parsed;
  }

  const specs = [];
  if (preferredSpec) specs.push(preferredSpec);
  for (const spec of downloadProxyCandidates()) {
    if (spec && !specs.includes(spec)) specs.push(spec);
  }

  for (const spec of specs) {
    const probe = await probeProxyConnect(spec);
    if (probe.ok) return parseCustomProxy(spec);
  }
  return downloadProxyUrl();
}

function downloadProxyLabel() {
  if (process.env.TNT_DOWNLOAD_PROXY === '0') return null;
  const explicit = String(process.env.TNT_DOWNLOAD_PROXY || '').trim();
  if (explicit && explicit !== '0') return proxyDisplayLabel(explicit);
  for (const spec of downloadProxyCandidates()) {
    if (spec) return proxyDisplayLabel(spec);
  }
  return null;
}

function isProxyTransportError(err) {
  return /CONNECT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket disconnected/i.test(String(err?.message || err));
}

function requestBufferOnce(url, { method = 'GET', headers = {}, body = null, agent, timeout = 45000, step } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method, headers, agent, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`${step || 'Request'} HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`);
          err.status = res.statusCode;
          reject(err);
          return;
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${step || 'Request'} timeout`)));
    if (body) req.write(body);
    req.end();
  });
}

async function requestBuffer(url, options = {}) {
  const specs = options.useProxy === false ? [null] : proxyCandidates();
  let lastErr;
  for (const spec of specs) {
    try {
      const agent = spec ? agentForSpec(spec, options.timeout || 20000) : undefined;
      return await requestBufferOnce(url, { ...options, agent });
    } catch (err) {
      lastErr = err;
      if (options.useProxy === false) throw err;
      if (!isProxyTransportError(err) && err.status) throw err;
    }
  }
  if (options.allowDirect !== false && options.useProxy !== false) {
    try {
      return await requestBufferOnce(url, { ...options, agent: undefined });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Request failed');
}

module.exports = {
  requestBuffer,
  requestBufferOnce,
  apiProxyCandidates,
  proxyCandidates,
  downloadProxyCandidates,
  agentForSpec,
  downloadProxyUrl,
  resolveDownloadProxyUrl,
  probeProxyConnect,
  downloadProxyLabel,
  parseProxyForPlaywright,
  resolvePlaywrightProxy,
  isProxyTransportError,
};
