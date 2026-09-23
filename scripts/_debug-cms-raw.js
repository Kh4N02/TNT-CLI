'use strict';
const { loadEnv } = require('../lib/max-api');
const { loadSession } = require('../lib/max-session');
const { cmsSearch, searchCollectionId, parseCollectionItems } = require('../lib/max-cms');
const https = require('https');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { parseCustomProxy } = require('../vendor/proxy-parse');
const { sessionHeaders, sessionCookies } = require('../lib/max-session');

loadEnv();

function agentFor(spec) {
  const url = parseCustomProxy(spec);
  return url ? new HttpsProxyAgent(url, { timeout: 20000 }) : undefined;
}

function get(url, agent, headers, cookies) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...headers };
    if (cookies) h.Cookie = cookies;
    const req = https.request(u, { method: 'GET', headers: h, agent, timeout: 45000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const session = loadSession();
  const cid = await searchCollectionId(session);
  const params = new URLSearchParams({
    include: 'default',
    decorators: 'viewingHistory,badges,isFavorite,contentAction',
    'page[items.size]': '50',
    'page[items.number]': '1',
  });
  params.set('pf[query]', 'england');
  const path = `/cms/collections/${cid}?${params}`;
  const base = `https://${session.apiHost}${path}`;
  const hdrs = sessionHeaders(session);
  const cookies = sessionCookies(session);

  for (const label of ['tunnel', 'direct']) {
    const spec = label === 'tunnel'
      ? process.env.TNT_PROXY_TUNNEL
      : process.env.TNT_PROXY;
    try {
      const r = await get(base, agentFor(spec), hdrs, cookies);
      const refs = r.data?.data?.relationships?.items?.data?.length ?? r.data?.relationships?.items?.data?.length;
      const json = r.data?.data ? r.data : r.data;
      const actual = json.data || json;
      const n = actual?.relationships?.items?.data?.length;
      const { items } = parseCollectionItems(json);
      console.log(label, spec, 'status', r.status, 'refs', n, 'parsed', items.length);
    } catch (e) {
      console.log(label, spec, 'ERROR', e.message);
    }
  }

  const items = await cmsSearch(session, 'england', { onStatus: console.log });
  console.log('cmsSearch total', items.length);
})();
