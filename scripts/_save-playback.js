'use strict';
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/max-api');
const { loadSession, sessionHeaders, sessionCookies } = require('../lib/max-session');
const https = require('https');
const { URL } = require('url');
const { apiProxyCandidates, agentForSpec } = require('../lib/proxy-request');

loadEnv();
const s = loadSession();
const editId = process.argv[2] || '92d887a3-f5a6-43e5-8ce5-a1b60771998c';
const body = JSON.stringify({
  editId,
  consumptionType: 'streaming',
  firstPlay: false,
  gdpr: false,
  userPreferences: {},
  capabilities: {
    contentProtection: { contentDecryptionModules: [{ drmKeySystem: 'widevine' }] },
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
const url = `https://${s.apiHost}/playback-orchestrator/any/playback-orchestrator/v1/playbackInfo`;
const u = new URL(url);
const h = { ...sessionHeaders(s), 'Content-Type': 'application/json', Cookie: sessionCookies(s) };
const req = https.request(u, { method: 'POST', headers: h, agent: agentForSpec(apiProxyCandidates()[0]) }, (res) => {
  let d = '';
  res.on('data', (c) => { d += c; });
  res.on('end', () => {
    const out = path.join(__dirname, '_playback.json');
    fs.writeFileSync(out, d);
    console.log('wrote', out, 'license mentions', (d.match(/license/gi) || []).length);
    console.log('keys', Object.keys(JSON.parse(d)));
  });
});
req.write(body);
req.end();
