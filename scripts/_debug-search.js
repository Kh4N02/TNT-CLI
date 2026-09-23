'use strict';

require('../lib/max-api').loadEnv();
const s = require('../lib/max-session').loadSession();
const cms = require('../lib/max-cms');

(async () => {
  const cid = await cms.searchCollectionId(s);
  const params = new URLSearchParams({
    include: 'default',
    decorators: 'viewingHistory,badges,isFavorite,contentAction',
    'page[items.size]': '50',
    'page[items.number]': '1',
  });
  params.set('pf[query]', 'england');
  const https = require('https');
  const { sessionHeaders, sessionCookies } = require('../lib/max-session');
  const url = `https://${s.apiHost}/cms/collections/${cid}?${params}`;
  const h = { ...sessionHeaders(s), Cookie: sessionCookies(s) };
  const json = await new Promise((resolve, reject) => {
    https.get(url, { headers: h }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  const { items: parsed } = cms.parseCollectionItems(json);
  console.log('parsed', parsed.length, parsed.map((i) => i.title));
  const hydrated = await cms.hydrateShowEditIds(s, parsed);
  console.log('final', hydrated.length, hydrated.map((i) => i.title));
})().catch((e) => console.error(e));
