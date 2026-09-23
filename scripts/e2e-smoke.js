'use strict';

const { loadEnv, authenticate, fetchSearch, sessionReadyForPlayback } = require('../lib/max-api');
const { cmsSearch } = require('../lib/max-cms');
const { resolveMaxPlayback } = require('../lib/max-playback');

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('OK:', msg);
}

(async () => {
  loadEnv();
  process.env.TNT_ALLOW_ANONYMOUS = '1';
  const session = await authenticate((m) => console.log('*', m));
  if (!session?.apiHost) fail('no apiHost');
  ok(`session ${session.apiHost}`);

  for (const q of ['england', 'TNT Sports', 'Premier League']) {
    const items = await cmsSearch(session, q, { onStatus: () => {} });
    if (!items.length) fail(`search "${q}" returned 0 items`);
    ok(`search "${q}" → ${items.length} items (first: ${items[0].title})`);
    const withEdit = items.filter((i) => i.editId);
    if (!withEdit.length) fail(`search "${q}" — no editId on any item`);
    ok(`search "${q}" → ${withEdit.length} with editId`);
  }

  if (!(await sessionReadyForPlayback(session))) {
    console.log('\nSKIP playback keys: session is guest/anonymous.');
    console.log('Run: set TNT_DEVICE_LOGIN=1 && node tnt_cmd.js — link TV at play.hbomax.com/link');
    console.log('\nSEARCH SMOKE TESTS PASSED');
    process.exit(0);
  }

  const sports = await cmsSearch(session, 'TNT Sports', { onStatus: () => {} });
  const pick = sports.find((i) => i.editId) || sports[0];
  console.log('* playback probe:', pick.title, pick.editId);
  const playback = await resolveMaxPlayback(session, pick.editId, {
    onStatus: (m) => console.log('*', m),
  });
  if (!playback.manifestUrl) fail('no manifest URL');
  if (!playback.keys?.length) fail('no keys (remote CDM or license failed)');
  ok(`playback keys=${playback.keys.length} manifest=${playback.manifestUrl.slice(0, 60)}...`);
  console.log('\nALL SMOKE TESTS PASSED');
})().catch((e) => {
  console.error('\nSMOKE FAILED:', e.message || e);
  process.exit(1);
});
