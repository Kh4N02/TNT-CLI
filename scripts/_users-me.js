'use strict';
const { loadEnv, authenticate } = require('../lib/max-api');
const { sessionHeaders, sessionCookies } = require('../lib/max-session');
const https = require('https');
const { URL } = require('url');
const { apiProxyCandidates, agentForSpec } = require('../lib/proxy-request');

loadEnv();
(async () => {
  const session = await authenticate(() => {});
  const url = `https://${session.apiHost}/users/me`;
  const u = new URL(url);
  const req = https.request(u, {
    method: 'GET',
    headers: { ...sessionHeaders(session), Cookie: sessionCookies(session) },
    agent: agentForSpec(apiProxyCandidates()[0]),
  }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => {
      const j = JSON.parse(d);
      const attrs = j.data?.attributes || j.attributes || {};
      console.log('anonymous', attrs.anonymous);
      console.log('registrationState', attrs.registrationState);
      console.log('packages', attrs.packages?.length ?? attrs.selectedPackageIds);
      console.log('email', attrs.email || attrs.username);
    });
  });
  req.end();
})();
