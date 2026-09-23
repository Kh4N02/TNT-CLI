'use strict';

const {
  cmsGet,
  cmsCollectionItems,
  cmsPageRails,
  cmsRouteFetch,
  collectionItemsFromRouteJson,
  displayCollectionTitle,
} = require('./max-cms');

const MENU_BAR_ID = 'web-menu-bar';
const MENU_SKIP = new Set(['search-menu-item', 'my-stuff-menu-item']);

const GENRE_CATEGORIES = [
  { label: 'Drama', route: '/genre/drama' },
  { label: 'Fantasy & Sci-Fi', route: '/genre/fantasy-sci-fi' },
  { label: 'Comedy', route: '/genre/comedy' },
  { label: 'Action', route: '/genre/action' },
  { label: 'Horror', route: '/genre/horror' },
  { label: 'Kids & Family', route: '/genre/kids-family' },
  { label: 'Adult Animation', route: '/genre/adult-animation' },
];

function includedMap(json) {
  return new Map((json.included || []).map((r) => [r.id, r]));
}

function routeUrlFromMenuCollection(json) {
  const inc = includedMap(json);
  for (const ref of json.data?.relationships?.items?.data || []) {
    const ci = inc.get(ref.id);
    const linkId = ci?.relationships?.link?.data?.id;
    const link = linkId ? inc.get(linkId) : null;
    const routes = link?.relationships?.linkedContentRoutes?.data || [];
    for (const rr of routes) {
      const route = inc.get(rr.id);
      const url = route?.attributes?.url;
      if (url) return url;
    }
  }
  return null;
}

async function fetchMainNavEntries(session, { onStatus } = {}) {
  const status = onStatus || (() => {});
  status('Loading HBO Max menu (web-menu-bar)...');
  const json = await cmsGet(
    session,
    `/cms/collections/${MENU_BAR_ID}`,
    'include=default&page[items.size]=50',
  );
  const inc = includedMap(json);
  const entries = [];

  for (const ref of json.data?.relationships?.items?.data || []) {
    const ci = inc.get(ref.id);
    const colId = ci?.relationships?.collection?.data?.id;
    const col = colId ? inc.get(colId) : null;
    const name = col?.attributes?.name || col?.attributes?.alias || '';
    if (!col || MENU_SKIP.has(name)) continue;

    const label = col.attributes?.title || col.attributes?.name || name;
    const menuJson = await cmsGet(
      session,
      `/cms/collections/${colId}`,
      'include=default&page[items.size]=20',
    );
    const route = routeUrlFromMenuCollection(menuJson);
    if (!route) {
      status(`Menu skip (no route): ${label}`);
      continue;
    }
    entries.push({ label, route, menuCollectionId: colId });
  }

  return entries;
}

function buildBrowseCategories(navEntries) {
  const out = [{ key: 'search', label: 'Search', isSearch: true }];

  for (const row of navEntries) {
    out.push({
      key: `page:${row.route}`,
      label: row.label,
      pageRoute: row.route,
    });
  }

  out.push({
    key: 'categories',
    label: 'Categories',
    subCategories: GENRE_CATEGORIES.map((g) => ({
      key: `genre:${g.route}`,
      label: g.label,
      pageRoute: g.route,
    })),
  });

  return out;
}

function humanRailLabel(rail) {
  return displayCollectionTitle({
    attributes: {
      title: rail.title,
      alias: rail.title,
      name: rail.title,
      component: { id: rail.componentId },
    },
  });
}

async function findTaxonomyRouteByTitle(session, label) {
  const { rails } = await cmsPageRails(session, '/sports');
  const tnt = rails.find((r) => /^tnt sports$/i.test(String(r.title)) && r.componentId === '2-3')
    || rails.find((r) => /^tnt sports$/i.test(String(r.title)));
  if (!tnt?.collectionId) return null;
  const items = await cmsCollectionItems(session, tnt.collectionId, {
    parentRoute: '/sports',
    onStatus: () => {},
  });
  const want = String(label || '').trim().toLowerCase();
  const hit = items.find((i) => i.pageRoute && String(i.title).trim().toLowerCase() === want);
  return hit?.pageRoute || null;
}

function filterItemsForSportContext(items, sportLabel) {
  const key = String(sportLabel || '').trim().toLowerCase();
  if (!key) return items;
  const re = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return items.filter((item) => {
    if (item.pageRoute && re.test(item.pageRoute)) return true;
    if (re.test(item.title || '')) return true;
    if (re.test(item.channel || '')) return true;
    return false;
  });
}

/** Prefer real video rows on sport hubs (not the “TNT Sports” taxonomy row). */
const SPORT_HUB_VIDEO_RAIL_PATTERNS = [
  /caribbean premier league/i,
  /extended highlights/i,
  /^latest$/i,
  /^live$/i,
  /^upcoming$/i,
  /in case you missed/i,
  /^hero$/i,
  /featured event/i,
];

function pickSportHubVideoRailIndex(rails) {
  for (const pat of SPORT_HUB_VIDEO_RAIL_PATTERNS) {
    const idx = rails.findIndex((r) => pat.test(humanRailLabel(r)));
    if (idx >= 0) return idx;
  }
  const idx = rails.findIndex((r) => {
    const t = humanRailLabel(r);
    return !/^tnt sports$/i.test(t) && r.kind === 'automatic';
  });
  return idx >= 0 ? idx : null;
}

function playableBrowseItems(items) {
  return (items || []).filter((i) => i.editId || i._needsEditLookup);
}

async function openSportHubWithVideos(session, hubRoute, sportLabel, { onStatus } = {}) {
  const status = onStatus || (() => {});
  const path = hubRoute.startsWith('/') ? hubRoute : `/${hubRoute}`;
  status(`Opening ${sportLabel} hub ${path}...`);
  const { title, rails } = await cmsPageRails(session, path);
  if (!rails.length) {
    return { title: sportLabel, items: [], pageRoute: path };
  }

  const tryOrder = [];
  const preferred = pickSportHubVideoRailIndex(rails);
  if (preferred != null) tryOrder.push(preferred);
  for (let i = 0; i < rails.length; i++) {
    if (!tryOrder.includes(i) && !/^tnt sports$/i.test(humanRailLabel(rails[i]))) {
      tryOrder.push(i);
    }
  }

  for (const idx of tryOrder) {
    const rail = rails[idx];
    const items = await loadRailItems(session, rail, {
      onStatus: status,
      parentRoute: path,
      sportContext: null,
    });
    if (!Array.isArray(items)) continue;
    const playable = playableBrowseItems(items);
    if (playable.length) {
      return {
        title: `${title} — ${humanRailLabel(rail)}`,
        items,
        pageRoute: path,
      };
    }
  }

  if (rails.length > 1) {
    return {
      title: sportLabel || title,
      rails,
      needsRailPick: true,
      pageRoute: path,
      items: [],
    };
  }

  return { title: `${title} — ${humanRailLabel(rails[0])}`, items: [], pageRoute: path };
}

async function loadRailItems(session, rail, { onStatus, depth = 0, parentRoute = null, sportContext = null } = {}) {
  const status = onStatus || (() => {});
  const label = humanRailLabel(rail);

  if (rail.inlineItems?.length) {
    let items = rail.inlineItems;
    if (sportContext) items = filterItemsForSportContext(items, sportContext);
    return items;
  }

  status(`Loading “${label}”...`);
  let items = await cmsCollectionItems(session, rail.collectionId, {
    onStatus: status,
    parentRoute,
  });

  if (items.some((i) => i.pageRoute || i.collectionId)) {
    if (sportContext) items = filterItemsForSportContext(items, sportContext);
    return items;
  }

  if (!items.length && depth < 1) {
    const hubRoute = await findTaxonomyRouteByTitle(session, label);
    if (hubRoute) {
      return { __openHub: hubRoute, sportLabel: label };
    }
  }

  if (sportContext) items = filterItemsForSportContext(items, sportContext);
  return items;
}

async function fetchPageBrowseItems(session, routePath, { onStatus, railIndex = null, sportContext = null } = {}) {
  const status = onStatus || (() => {});
  const path = routePath.startsWith('/') ? routePath : `/${routePath}`;
  status(`Loading ${path}...`);
  const { title, rails } = await cmsPageRails(session, path);

  if (!rails.length) return { title, items: [], pageRoute: path };

  let displayRails = rails;

  let rail = displayRails[0];
  if (displayRails.length > 1 && railIndex == null) {
    return { title, rails: displayRails, needsRailPick: true, pageRoute: path };
  }
  if (railIndex != null && displayRails[railIndex]) rail = displayRails[railIndex];

  let items = await loadRailItems(session, rail, {
    onStatus: status,
    parentRoute: path,
    sportContext,
  });

  if (items && items.__openHub) {
    return openSportHubWithVideos(session, items.__openHub, items.sportLabel, { onStatus: status });
  }

  return {
    title: `${title} — ${humanRailLabel(rail)}`,
    items: items || [],
    pageRoute: path,
  };
}

async function fetchCollectionBrowseItems(session, collectionId, { onStatus, label = 'Collection', parentRoute = null } = {}) {
  const status = onStatus || (() => {});
  status(`Loading ${label}...`);
  const items = await cmsCollectionItems(session, collectionId, { onStatus: status, parentRoute });
  return { title: label, items };
}

module.exports = {
  GENRE_CATEGORIES,
  fetchMainNavEntries,
  buildBrowseCategories,
  fetchPageBrowseItems,
  fetchCollectionBrowseItems,
  humanRailLabel,
  filterItemsForSportContext,
  openSportHubWithVideos,
  pickSportHubVideoRailIndex,
};
