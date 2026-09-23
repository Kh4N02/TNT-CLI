'use strict';
const { loadEnv } = require('../lib/max-api');
const { loadSession, bootstrap, saveSession, resolveEndpoint, sessionHeaders, sessionCookies } = require('../lib/max-session');
const { apiRequestJson } = require('../lib/max-cms');

loadEnv();
(async () => {
  let s = loadSession();
  if (!s.bootstrap) {
    const boot = await bootstrap(s.st, s.deviceUuid, s.installId);
    s = saveSession({ bootstrap: boot.bootstrap, routing: boot.routing, apiHost: boot.apiHost });
  }
  const url = resolveEndpoint(s.bootstrap, '/authentication/linkDevice/initiate');
  console.log('url', url);
  const j = await apiRequestJson(url, {
    method: 'POST',
    headers: sessionHeaders(s),
    cookies: sessionCookies(s),
    body: '{}',
  });
  console.log('code', j?.data?.attributes?.linkingCode);
  console.log('target', j?.data?.attributes?.targetUrl);
})().catch((e) => console.error(e.message));
