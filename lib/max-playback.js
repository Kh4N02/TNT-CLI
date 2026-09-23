'use strict';

const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const play = require('../vendor/play');
const { sessionHeaders, sessionCookies } = require('./max-session');
const { UA, SITE_ORIGIN } = require('./max-constants');
const { quoteCmdArg, sanitizeSaveName } = require('./tnt-cmd-util');
const {
  downloadProxyUrl,
  resolveDownloadProxyUrl,
  apiProxyCandidates,
  agentForSpec,
  isProxyTransportError,
} = require('./proxy-request');
const { patchZeroKeysFromDiscovery, ZERO_KEY } = require('./tnt-key-patch');

function httpsBufferOnce(url, { method = 'GET', headers = {}, body = null, agent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, {
      method,
      headers,
      agent,
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`);
          err.status = res.statusCode;
          reject(err);
          return;
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function httpsBuffer(url, opts = {}) {
  let lastErr;
  for (const spec of apiProxyCandidates()) {
    try {
      return await httpsBufferOnce(url, {
        ...opts,
        agent: agentForSpec(spec, 60000),
      });
    } catch (err) {
      lastErr = err;
      if (err.status && err.status !== 502 && err.status !== 503) throw err;
      if (!isProxyTransportError(err) && !err.status) throw err;
    }
  }
  try {
    return await httpsBufferOnce(url, { ...opts, agent: undefined });
  } catch (err) {
    throw lastErr || err;
  }
}

function playbackBody(editId, session) {
  const deviceUuid = session?.deviceUuid || crypto.randomUUID();
  return JSON.stringify({
    editId,
    appBundle: 'com.wbd.stream',
    applicationSessionId: deviceUuid,
    consumptionType: 'streaming',
    firstPlay: false,
    gdpr: false,
    playbackSessionId: crypto.randomUUID(),
    userPreferences: {},
    capabilities: {
      codecs: {
        audio: {
          decoders: [
            { codec: 'aac', profiles: ['lc', 'he', 'hev2', 'xhe'] },
            { codec: 'eac3', profiles: ['atmos'] },
          ],
        },
        video: {
          decoders: [
            {
              codec: 'h264',
              levelConstraints: {
                framerate: { max: 960, min: 0 },
                height: { max: 2176, min: 48 },
                width: { max: 3840, min: 48 },
              },
              maxLevel: '5.2',
              profiles: ['baseline', 'main', 'high'],
            },
            {
              codec: 'h265',
              levelConstraints: {
                framerate: { max: 960, min: 0 },
                height: { max: 2176, min: 144 },
                width: { max: 3840, min: 144 },
              },
              maxLevel: '5.1',
              profiles: ['main', 'main10'],
            },
          ],
          hdrFormats: ['hdr10', 'hdr10plus', 'dolbyvision', 'dolbyvision5', 'dolbyvision8', 'hlg'],
        },
      },
      contentProtection: {
        contentDecryptionModules: [{ drmKeySystem: 'widevine', maxSecurityLevel: 'L1' }],
      },
      manifests: { formats: { dash: {} } },
    },
    deviceInfo: {
      player: {
        mediaEngine: { name: 'Chrome', version: '145' },
        playerView: { height: 1080, width: 1920 },
        sdk: { name: 'beam-web', version: '7.7.0' },
      },
    },
  });
}

async function fetchPlaybackInfo(session, editId) {
  const url = `https://${session.apiHost}/playback-orchestrator/any/playback-orchestrator/v1/playbackInfo`;
  const headers = {
    ...sessionHeaders(session),
    'Content-Type': 'application/json',
    Cookie: sessionCookies(session),
  };
  const token = session.accessToken || session.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  const buf = await httpsBuffer(url, {
    method: 'POST',
    headers,
    body: playbackBody(editId, session),
  });
  const json = JSON.parse(buf.toString('utf8'));
  if (json.errors?.length) {
    throw new Error(json.errors[0].detail || json.errors[0].message || 'Playback failed');
  }
  if (json.type === 'Error') {
    throw new Error(json.message || json.details?.message || 'Playback failed');
  }
  return json;
}

function pickManifestUrl(playback) {
  const primary = playback?.manifest?.url;
  if (primary) return primary;
  const fallback = playback?.fallback?.manifest?.url;
  if (fallback) return String(fallback).replace('_fallback', '');
  throw new Error('No DASH manifest in playback response');
}

/** Human label for HBO multi-CDN hostnames (assigned by playback orchestrator, not the CLI). */
function cdnLabelFromManifestUrl(manifestUrl) {
  const host = (String(manifestUrl).match(/https:\/\/([^/?#]+)/i) || [])[1] || '';
  if (/^gcp\.eu\.prd\.media\.max\.com$/i.test(host)) return 'gcp.eu (Google)';
  if (/^akm\.eu\.prd\.media\.max\.com$/i.test(host)) return 'akm.eu (Akamai)';
  if (/\.cf\.eu\.prd\.media\.max\.com$/i.test(host)) return 'cf.eu (CloudFront)';
  if (/^ab[a-z0-9]+\.cf\.eu\.prd\.media\.max\.com$/i.test(host)) return 'cf.eu (CloudFront)';
  if (host) return host.split('.')[0] + '.eu';
  return 'hbomax-cmaf';
}

function isHboDrmProxyUrl(url) {
  return /discomax\.com\/drm-proxy|busy\.any-any\.prd\.api\.discomax/i.test(String(url || ''));
}

function pickWidevineUrl(playback) {
  const drm = playback?.drm || playback?.fallback?.drm || {};
  const schemes = drm.schemes || {};
  const wv = schemes.widevine || schemes.Widevine || {};
  let url = wv.licenseUrl || drm.licenseUrl;
  if (!url) throw new Error('No Widevine license URL in playback response');

  const authToken = wv.authToken || wv.licenseToken || drm.authToken || drm.licenseToken;
  if (authToken && !String(url).includes('auth=')) {
    const u = new URL(url);
    u.searchParams.set('auth', authToken);
    url = u.toString();
  }
  return url;
}

async function fetchMpdText(manifestUrl) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    Origin: SITE_ORIGIN,
    Referer: `${SITE_ORIGIN}/`,
  };
  const buf = await httpsBuffer(manifestUrl, { headers });
  return buf.toString('utf8');
}

function maxLicenseHeaders(session, contentType, licenseUrl) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    Origin: SITE_ORIGIN,
    Referer: `${SITE_ORIGIN}/`,
    'Content-Type': contentType,
  };
  const url = String(licenseUrl || '');
  const authInUrl = /[?&]auth=/.test(url);

  // HBO drm-proxy: auth JWT is in the URL (same as browser) — Bearer often breaks it.
  if (isHboDrmProxyUrl(url) || authInUrl) {
    try {
      const u = new URL(url);
      const tenant = u.searchParams.get('x-wbd-tenant');
      const market = u.searchParams.get('x-wbd-user-home-market');
      if (tenant) headers['x-wbd-tenant'] = tenant;
      if (market) headers['x-wbd-user-home-market'] = market;
    } catch {
      // ignore
    }
    if (!authInUrl) {
      Object.assign(headers, sessionHeaders(session));
      const cookies = sessionCookies(session);
      if (cookies) headers.Cookie = cookies;
    }
    return headers;
  }

  Object.assign(headers, sessionHeaders(session));
  const cookies = sessionCookies(session);
  if (cookies) headers.Cookie = cookies;
  const token = session.accessToken || session.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchMaxWidevineLicense(licenseUrl, challengeB64, session) {
  const body = Buffer.from(challengeB64, 'base64');
  const buf = await httpsBuffer(licenseUrl, {
    method: 'POST',
    headers: maxLicenseHeaders(session, 'application/octet-stream', licenseUrl),
    body,
  });
  return buf.toString('base64');
}

async function fetchMaxPlayReadyLicense(licenseUrl, challengeB64, session) {
  const buf = await httpsBuffer(licenseUrl, {
    method: 'POST',
    headers: {
      ...maxLicenseHeaders(session, 'text/xml; charset=UTF-8', licenseUrl),
      SOAPAction: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"',
    },
    body: Buffer.from(challengeB64, 'base64'),
  });
  return buf.toString('base64');
}

/** Widevine / PlayReady keys via remote CDM HTTP API (vendor/play.js). */
async function extractKeysNoPython(mpdXml, licenseUrl, session, logs) {
  const hboProxy = isHboDrmProxyUrl(licenseUrl) || /license\/widevine/i.test(licenseUrl);

  if (!hboProxy) {
    const entry = { LaUrl: licenseUrl };
    const playback = { LaUrl: licenseUrl, PlayReadyLaUrl: licenseUrl };
    const mpdPr = play.extractPlayReadyFromMpd(mpdXml);
    const playReadyUrl = play.pickPlayReadyLicenseUrl(entry, playback, mpdPr);

    if (mpdPr?.initData && playReadyUrl && play.isPlayReadyLicenseUrl(playReadyUrl)) {
      logs.push(`PlayReady license: ${playReadyUrl.slice(0, 72)}...`);
      const round = await play.startPlayReadyChallenge(mpdPr.initData);
      logs.push(...round.logs);
      const licenseB64 = await fetchMaxPlayReadyLicense(playReadyUrl, round.challengeB64, session);
      logs.push('PlayReady license received');
      const { keys, logs: keyLogs } = await play.finishPlayReadyKeys(round.sessionId, licenseB64, {
        localPrd: round.localPrd,
      });
      logs.push(...keyLogs);
      return keys;
    }
  } else {
    logs.push('HBO Max drm-proxy — Widevine license (not PlayReady SOAP)');
  }

  const psshs = play.extractAllWidevinePsshFromMpd(mpdXml);
  const pssh = psshs[0] || play.extractPsshFromMpd(mpdXml);
  if (!pssh) throw new Error('No DRM init data in MPD');

  logs.push('Widevine PSSH extracted (remote CDM — no Python)');
  if (!/[?&]auth=/.test(licenseUrl)) {
    logs.push('Warning: license URL has no auth= token — playback may 400 until session is linked');
  }
  const round = await play.startWidevineChallenge(pssh);
  logs.push(...round.logs);
  let licenseB64;
  try {
    licenseB64 = await fetchMaxWidevineLicense(licenseUrl, round.challengeB64, session);
  } catch (err) {
    const msg = String(err.message || err);
    throw new Error(
      `Widevine license failed (${msg}). `
      + 'Ensure tnt-token.json is from TNT_DEVICE_LOGIN=1 (play.hbomax.com/link).',
    );
  }
  logs.push('Widevine license received');
  const { keys, logs: keyLogs } = await play.finishWidevineKeys(round.sessionId, licenseB64);
  logs.push(...keyLogs);
  return keys;
}

function pickPlaybackTitle(playback, editId, displayTitle) {
  const fromBrowse = String(displayTitle || '').trim();
  if (fromBrowse && fromBrowse !== editId && !/^[0-9a-f-]{36}$/i.test(fromBrowse)) {
    return fromBrowse;
  }
  const meta = playback?.metadata || playback?.content?.metadata || {};
  return (
    meta.title
    || meta.programTitle
    || meta.name
    || meta.secondaryTitle
    || playback?.title
    || editId
  );
}

/** Headers for media.max.com segment requests (browser-like; no Bearer on CDN). */
function isMaxLiveOrQuickvodManifest(manifestUrl) {
  const u = String(manifestUrl || '');
  return /fly\.live\.|\.live\.eu\.prd\.media\.max\.com\/live\//i.test(u)
    || /[?&]vod=true/i.test(u)
    || /admo\.type=run[dD][mM][cC]/i.test(u);
}

function maxCdnDownloadHeaders(manifestUrl) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    Referer: `${SITE_ORIGIN}/`,
    Origin: SITE_ORIGIN,
  };
  try {
    const u = new URL(manifestUrl);
    const tenant = u.searchParams.get('x-wbd-tenant');
    const market = u.searchParams.get('x-wbd-user-home-market');
    if (tenant) headers['x-wbd-tenant'] = tenant;
    if (market) headers['x-wbd-user-home-market'] = market;
  } catch {
    // ignore
  }
  return headers;
}

function buildDownloadArgv(manifestUrl, keys, title, session, { proxyUrl = null } = {}) {
  const exe = process.env.TNT_NM3U8DL || 'N_m3u8DL-RE';
  const saveName = sanitizeSaveName(title) || 'TNT_Video';
  const saveDir = process.env.TNT_DOWNLOAD_DIR;
  const cwd = saveDir ? path.resolve(saveDir) : path.join(__dirname, '..');

  const args = [manifestUrl];

  for (const k of keys || []) {
    const key = String(k.key || '').toLowerCase();
    if (!k.kid || !key || key === ZERO_KEY) continue;
    args.push('--key', `${k.kid}:${key}`);
  }

  for (const [hk, hv] of Object.entries(maxCdnDownloadHeaders(manifestUrl))) {
    args.push('-H', `${hk}: ${hv}`);
  }

  const resolvedProxy = proxyUrl !== undefined ? proxyUrl : downloadProxyUrl();
  if (resolvedProxy) {
    args.push('--custom-proxy', resolvedProxy);
  }

  args.push(
    '-mt',
    '--check-segments-count', 'false',
    '--disable-update-check',
    '--use-system-proxy', 'false',
    '--download-retry-count', '5',
  );

  if (isMaxLiveOrQuickvodManifest(manifestUrl)) {
    args.push('--live-perform-as-vod');
  }

  args.push('-sv', 'best');
  // Prefer AAC when present (browser-style); avoids EAC3 5.1 + mkvmerge mux failures on some CDNs.
  const audioSel = process.env.TNT_AUDIO_SELECT || 'codecs=mp4a:for=best';
  args.push('-sa', audioSel, '-ss', 'best:for=best');

  if (process.env.TNT_USE_SHAKA_PACKAGER !== '0') {
    args.push('--use-shaka-packager');
  }

  args.push('--save-name', saveName);
  const mux = process.env.TNT_MUX_AFTER_DONE || 'format=mp4';
  args.push('--mux-after-done', mux);
  if (saveDir) {
    args.push('--save-dir', cwd);
  }

  return { exe, args, cwd };
}

/** Human-readable command for keys.txt / console (not for cmd.exe). */
function buildDownloadCmd(manifestUrl, keys, title, session, opts = {}) {
  const { exe, args } = buildDownloadArgv(manifestUrl, keys, title, session, opts);
  const parts = [exe];
  for (const arg of args) {
    parts.push(/\s|[|&<>^"]/.test(arg) ? quoteCmdArg(arg) : arg);
  }
  return parts.join(' ');
}

async function resolveMaxPlayback(session, editId, { onStatus, displayTitle = null } = {}) {
  const logs = [];
  const status = onStatus || (() => {});
  status(`Playback API for edit ${editId}...`);
  const playback = await fetchPlaybackInfo(session, editId);
  const manifestUrl = pickManifestUrl(playback);
  if (/\.(?:emea|amer)-free\./i.test(manifestUrl) && !playback?.drm) {
    throw new Error(
      'Guest/free preview stream (no DRM). Delete tnt-token.json and sign in again: '
      + 'set TNT_DEVICE_LOGIN=1 and link at play.hbomax.com/link, or complete browser login with TNT_MANUAL_LOGIN=1',
    );
  }
  logs.push(`Manifest: ${manifestUrl.slice(0, 80)}...`);

  status('Fetching MPD...');
  const mpdXml = await fetchMpdText(manifestUrl);
  logs.push('MPD fetched');

  let licenseUrl;
  try {
    licenseUrl = pickWidevineUrl(playback);
  } catch {
    const mpdPr = play.extractPlayReadyFromMpd(mpdXml);
    licenseUrl = mpdPr?.laUrl;
    if (!licenseUrl) {
      const m = String(mpdXml).match(/https:\/\/[^\s<"]+(?:widevine|playready)[^\s<"]*/i);
      licenseUrl = m ? m[0] : null;
    }
    if (!licenseUrl) throw new Error('No Widevine license URL in playback response');
    logs.push('License URL taken from MPD');
  }

  status('Getting decryption keys (N_m3u8DL-RE path — no Python)...');
  let keys = await extractKeysNoPython(mpdXml, licenseUrl, session, logs);

  const patched = patchZeroKeysFromDiscovery(keys);
  keys = patched.keys;
  if (patched.patched > 0) {
    logs.push(
      `Patched ${patched.patched} placeholder key(s) from ${path.basename(patched.keyFile)}`,
    );
  }
  if (patched.missingKids.length) {
    logs.push(
      `Warning: ${patched.missingKids.length} zero key(s) not in Discovery file: `
      + `${patched.missingKids.slice(0, 3).join(', ')}${patched.missingKids.length > 3 ? '…' : ''}`,
    );
  }

  const title = pickPlaybackTitle(playback, editId, displayTitle);
  const proxyUrl = await resolveDownloadProxyUrl();
  if (proxyUrl) {
    logs.push('Download proxy enabled for N_m3u8DL-RE');
  } else {
    logs.push('Download direct (no proxy) — set TNT_PROXY_TUNNEL if segments 404');
  }

  const downloadOpts = { proxyUrl };
  const downloadLaunch = buildDownloadArgv(manifestUrl, keys, title, session, downloadOpts);

  return {
    title,
    manifestUrl,
    licenseUrl,
    keys,
    keysPatchedFromDiscovery: patched.patched,
    logs,
    cmd: buildDownloadCmd(manifestUrl, keys, title, session, downloadOpts),
    downloadLaunch,
    cdnName: cdnLabelFromManifestUrl(manifestUrl),
  };
}

module.exports = {
  resolveMaxPlayback,
  buildDownloadCmd,
  buildDownloadArgv,
  fetchPlaybackInfo,
  pickWidevineUrl,
  cdnLabelFromManifestUrl,
};
