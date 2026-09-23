'use strict';

const { loadEnv, authenticate, loadCategories, getCategories } = require('../lib/max-api');
const { cmsSearch } = require('../lib/max-cms');
const { fetchPageBrowseItems, fetchMainNavEntries } = require('../lib/max-nav');

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

(async () => {
  loadEnv();
  process.env.TNT_ALLOW_ANONYMOUS = '1';
  const session = await authenticate(() => {});

  const nav = await fetchMainNavEntries(session, { onStatus: () => {} });
  if (nav.length < 4) fail(`web-menu-bar returned ${nav.length} entries (expected ≥4)`);
  console.log('OK: menu', nav.map((n) => n.label).join(', '));

  await loadCategories(session, () => {});
  const cats = getCategories();
  if (!cats.some((c) => c.label === 'TNT Sports')) fail('categories missing TNT Sports');

  const search = await cmsSearch(session, 'england', { onStatus: () => {} });
  if (!search.length) fail('search england returned 0');
  console.log('OK: search england', search.length, 'titles');

  const sports = await fetchPageBrowseItems(session, '/sports', { onStatus: () => {} });
  if (!sports.needsRailPick || !sports.rails?.length) fail('sports page has no rails');
  console.log('OK: sports rails', sports.rails.length);

  const tntRail = sports.rails.find((r) => r.title === 'TNT Sports' || /tnt sports/i.test(r.title));
  const tntIdx = tntRail ? sports.rails.indexOf(tntRail) : sports.rails.findIndex((r) => r.componentId === '2-3');
  const tntItems = await fetchPageBrowseItems(session, '/sports', {
    onStatus: () => {},
    railIndex: tntIdx >= 0 ? tntIdx : 4,
  });
  if (!tntItems.items?.length) fail('TNT Sports rail returned 0 items');
  console.log('OK: TNT Sports rail items', tntItems.items.length, '(first:', tntItems.items[0].title + ')');

  const heroIdx = sports.rails.findIndex((r) => r.componentId === 'hero');
  if (heroIdx >= 0) {
    const hero = await fetchPageBrowseItems(session, '/sports', { onStatus: () => {}, railIndex: heroIdx });
    if (!hero.items?.length) fail('sports hero rail empty');
    console.log('OK: sports hero items', hero.items.length);
  }

  const cricketIdx = sports.rails.findIndex((r) => /^Cricket$/i.test(r.title));
  if (cricketIdx >= 0) {
    let cricket = await fetchPageBrowseItems(session, '/sports', {
      onStatus: () => {},
      railIndex: cricketIdx,
    });
    if (cricket.needsRailPick) {
      const { openSportHubWithVideos } = require('../lib/max-nav');
      cricket = await openSportHubWithVideos(session, '/sport-event/cricket-hub', 'Cricket', {
        onStatus: () => {},
      });
      if (cricket.needsRailPick) {
        const { pickSportHubVideoRailIndex } = require('../lib/max-nav');
        const idx = pickSportHubVideoRailIndex(cricket.rails) ?? 0;
        cricket = await fetchPageBrowseItems(session, cricket.pageRoute || '/sport-event/cricket-hub', {
          onStatus: () => {},
          railIndex: idx,
        });
      }
    }
    const junk = (cricket.items || []).find((i) => /Gossip Girl|Chris Fleming|Evil Lives/i.test(i.title || ''));
    if (junk) fail(`Cricket rail polluted by text search: ${junk.title}`);
    if (!cricket.items?.length) {
      console.warn(
        'WARN: Cricket video rails empty from HBO API (re-link with TNT_DEVICE_LOGIN=1 if site shows matches)',
      );
    } else {
      console.log('OK: Cricket rail items', cricket.items.length, '(first:', cricket.items[0].title + ')');
    }
  }

  console.log('\nVERIFY CLI PASSED');
})().catch((e) => {
  console.error('VERIFY FAILED:', e.message || e);
  process.exit(1);
});
