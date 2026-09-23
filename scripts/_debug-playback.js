'use strict';
const { loadEnv } = require('../lib/max-api');
const { loadSession } = require('../lib/max-session');
const { cmsSearch } = require('../lib/max-cms');
const https = require('https');
const { URL } = require('url');
const { sessionHeaders, sessionCookies } = require('../lib/max-session');
const { apiProxyCandidates, agentForSpec } = require('../lib/proxy-request');

loadEnv();

function post(url, body, agent, headers, cookies) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...headers, 'Content-Type': 'application/json' };
    if (cookies) h.Cookie = cookies;
    const req = https.request(u, { method: 'POST', headers: h, agent, timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const crypto = require('crypto');
const playbackBody = (editId, session) => JSON.stringify({
  editId,
  appBundle: 'com.wbd.stream',
  applicationSessionId: session.deviceUuid || crypto.randomUUID(),
  consumptionType: 'streaming',
  firstPlay: false,
  gdpr: false,
  playbackSessionId: crypto.randomUUID(),
  userPreferences: {},
  capabilities: {
    contentProtection: { contentDecryptionModules: [{ drmKeySystem: 'widevine', maxSecurityLevel: 'L1' }] },
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

(async () => {
  const session = loadSession();
  const items = await cmsSearch(session, 'TNT Sports', { onStatus: () => {} });
  const pick = items.find((i) => i.editId) || items[0];
  console.log('pick', pick.title, pick.editId);

  const url = `https://${session.apiHost}/playback-orchestrator/any/playback-orchestrator/v1/playbackInfo`;
  const spec = apiProxyCandidates()[0];
  const r = await post(
    url,
    playbackBody(pick.editId, session),
    agentForSpec(spec),
    sessionHeaders(session),
    sessionCookies(session),
  );
  console.log('status', r.status);
  const j = JSON.parse(r.body || '{}');
  console.log('top keys', Object.keys(j));
  if (j.errors) console.log('errors', JSON.stringify(j.errors, null, 2));
  console.log('drm', JSON.stringify(j.drm || j.playback?.drm, null, 2)?.slice(0, 800));
  console.log('manifest', j.manifest?.url || j.playback?.manifest?.url || 'none');
  console.log('snippet', r.body.slice(0, 1200));
})();
