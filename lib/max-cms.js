'use strict';

const https = require('https');
const { URL } = require('url');
const { sessionHeaders, sessionCookies, loadSession, saveSession } = require('./max-session');
const {
  apiProxyCandidates,
  agentForSpec,
  isProxyTransportError,
} = require('./proxy-request');

function requestJsonOnce(url, { method = 'GET', headers = {}, cookies = '', body = null, agent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...headers };
    if (cookies) h.Cookie = cookies;
    if (body != null && !h['Content-Type'] && !h['content-type']) {
      h['Content-Type'] = 'application/json';
    }
    const req = https.request(u, {
      method,
      headers: h,
      agent,
      timeout: 45000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 240)}`);
          err.status = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(data || '{}'));
        } catch {
          reject(new Error('Response was not JSON'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (body != null) req.write(body);
    req.end();
  });
}

async function requestJson(url, opts = {}) {
  let lastErr;
  for (const spec of apiProxyCandidates()) {
    try {
      return await requestJsonOnce(url, {
        ...opts,
        agent: agentForSpec(spec, 45000),
      });
    } catch (err) {
      lastErr = err;
      if (err.status && err.status !== 502 && err.status !== 503) throw err;
      if (!isProxyTransportError(err) && !err.status) throw err;
    }
  }
  try {
    return await requestJsonOnce(url, { ...opts, agent: undefined });
  } catch (err) {
    throw lastErr || err;
  }
}

const DECORATORS = 'viewingHistory,badges,isFavorite,contentAction';
let cachedSearchCollectionId = null;

function apiBase(session) {
  return `https://${session.apiHost}`;
}

function cmsHeaders(session) {
  return {
    headers: sessionHeaders(session),
    cookies: sessionCookies(session),
  };
}

async function cmsGet(session, path, query = '') {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return requestJson(`${apiBase(session)}${path}${q}`, cmsHeaders(session));
}

async function searchCollectionId(session) {
  if (cachedSearchCollectionId) return cachedSearchCollectionId;
  const sess = loadSession();
  if (sess.searchCollectionId) {
    cachedSearchCollectionId = sess.searchCollectionId;
    return cachedSearchCollectionId;
  }

  const json = await cmsGet(session, '/cms/routes/search/result', 'include=default');
  const fromIncluded = (json.included || []).find((r) => r.type === 'collection');
  const fromTarget = json.data?.relationships?.target?.data;
  const id = fromIncluded?.id
    || (fromTarget?.type === 'collection' ? fromTarget.id : null);

  if (!id) {
    throw new Error('Could not resolve HBO Max search collection (try signing in again)');
  }
  cachedSearchCollectionId = id;
  saveSession({ searchCollectionId: id });
  return id;
}

function editIdFromRouteJson(json) {
  const edit = (json.included || []).find((r) => r.type === 'edit');
  if (edit?.id) return edit.id;
  const video = (json.included || []).find((r) => r.type === 'video');
  return video?.relationships?.edit?.data?.id || null;
}

function routeTypesForShowType(showType) {
  const st = String(showType || '').toUpperCase();
  if (st === 'MOVIE') return ['movie', 'show'];
  if (st === 'STANDALONE' || st === 'STANDALONE_EVENT') return ['sport', 'event', 'video', 'show'];
  if (/SPORT|LIVE/i.test(st)) return ['sport', 'event', 'video'];
  return ['show', 'movie', 'sport'];
}

function buildVideoEditIndex(included) {
  const byContentId = new Map();
  for (const row of included || []) {
    if (row.type !== 'video') continue;
    const editId = row.relationships?.edit?.data?.id;
    if (!editId) continue;
    const showId = row.relationships?.show?.data?.id;
    if (showId) byContentId.set(showId, editId);
    const alt = row.attributes?.alternateId;
    if (alt) byContentId.set(alt, editId);
  }
  return byContentId;
}

async function resolveEditIdForShow(session, showId, showType = '') {
  const q = 'include=default&page[items.size]=1';
  const types = routeTypesForShowType(showType);
  let lastErr;
  for (const routeType of types) {
    try {
      const json = await cmsGet(
        session,
        `/cms/routes/${routeType}/${encodeURIComponent(showId)}`,
        q,
      );
      const editId = editIdFromRouteJson(json);
      if (editId) return editId;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

function parseCollectionItems(json) {
  const included = new Map();
  for (const row of json.included || []) {
    if (row?.id) included.set(row.id, row);
  }
  const videoEditByContentId = buildVideoEditIndex(json.included);

  const itemRefs = json.data?.relationships?.items?.data || [];
  const items = [];

  for (const ref of itemRefs) {
    const ci = included.get(ref.id);
    if (!ci) continue;

    const showRef = ci.relationships?.show?.data;
    const videoRef = ci.relationships?.video?.data;
    const show = showRef ? included.get(showRef.id) : null;
    const video = videoRef ? included.get(videoRef.id) : null;

    const taxRef = ci.relationships?.taxonomyNode?.data;
    const tax = taxRef ? included.get(taxRef.id) : null;
    if (tax) {
      const routeRef = tax.relationships?.routes?.data?.[0];
      const route = routeRef ? included.get(routeRef.id) : null;
      const url = route?.attributes?.url || null;
      items.push({
        title: String(tax.attributes?.name || tax.attributes?.alternateId || tax.id),
        editId: null,
        showId: null,
        videoId: null,
        assetId: tax.id,
        videoType: tax.attributes?.kind || 'taxonomyNode',
        quality: 'HD',
        channel: 'TNT Sports',
        status: url ? 'Browse' : '',
        start: '',
        pageRoute: url,
        browseOnly: true,
        _needsEditLookup: false,
      });
      continue;
    }

    const linkRef = ci.relationships?.link?.data;
    const link = linkRef ? included.get(linkRef.id) : null;
    if (link) {
      const routeRef = link.relationships?.linkedContentRoutes?.data?.[0];
      const route = routeRef ? included.get(routeRef.id) : null;
      const url = route?.attributes?.url || null;
      items.push({
        title: String(link.attributes?.accessibilityTitle || link.attributes?.name || link.attributes?.alias || 'Link'),
        editId: null,
        showId: null,
        videoId: null,
        assetId: link.id,
        videoType: 'link',
        quality: 'HD',
        channel: 'HBO Max',
        status: url ? 'Open' : '',
        start: '',
        pageRoute: url,
        browseOnly: !url,
        _needsEditLookup: false,
      });
      continue;
    }

    const nestedColRef = ci.relationships?.collection?.data;
    if (nestedColRef) {
      const nested = included.get(nestedColRef.id);
      items.push({
        title: String(nested?.attributes?.title || nested?.attributes?.name || 'Collection'),
        editId: null,
        showId: null,
        videoId: null,
        assetId: nestedColRef.id,
        videoType: 'collection',
        quality: 'HD',
        channel: 'HBO Max',
        status: 'Browse',
        start: '',
        collectionId: nestedColRef.id,
        browseOnly: true,
        _needsEditLookup: false,
      });
      continue;
    }

    const entity = show || video;
    if (!entity) continue;

    const attrs = entity.attributes || {};
    const title = attrs.name || attrs.title || attrs.displayName || entity.id;
    const contentId = ci.meta?.analytics?.contentId || show?.id || video?.id;
    let editId = video?.relationships?.edit?.data?.id
      || (contentId ? videoEditByContentId.get(contentId) : null)
      || null;
    const showType = attrs.showType || attrs.videoType || entity.type || '';

    items.push({
      title: String(title),
      editId: editId ? String(editId) : null,
      showId: show ? String(show.id) : null,
      videoId: video ? String(video.id) : null,
      assetId: editId || show?.id || video?.id || ref.id,
      videoType: showType,
      quality: /4k|uhd|2160/i.test(JSON.stringify(attrs)) ? 'UHD' : 'HD',
      channel: attrs.primaryChannel?.name
        || included.get(show?.relationships?.primaryChannel?.data?.id)?.attributes?.name
        || 'HBO Max',
      status: attrs.availability?.state || '',
      start: attrs.airDate || attrs.premiereDate || attrs.publishStart || '',
      _needsEditLookup: !editId && !!(show?.id || contentId),
      _contentId: contentId ? String(contentId) : null,
    });
  }

  return { items };
}

async function hydrateShowEditIds(session, items) {
  const out = [];
  for (const item of items) {
    if (item.browseOnly || item.pageRoute || item.collectionId) {
      out.push(item);
      continue;
    }
    if (item.editId) {
      out.push({ ...item, assetId: item.editId });
      continue;
    }
    const lookupId = item.showId || item._contentId;
    if (!lookupId) continue;
    try {
      const editId = await resolveEditIdForShow(session, lookupId, item.videoType);
      if (editId) {
        out.push({
          ...item,
          editId,
          assetId: editId,
          _needsEditLookup: false,
        });
      } else {
        out.push({ ...item, assetId: lookupId });
      }
    } catch {
      out.push({ ...item, assetId: lookupId });
    }
  }
  return out;
}

function dedupeBrowseItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.editId || item.showId || item.videoId || item.assetId || item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function cmsSearch(session, query, { onStatus } = {}) {
  const status = onStatus || (() => {});
  const q = String(query || '').trim();
  if (!q) return [];

  try {
    await cmsRouteFetch(session, '/search/result', `pf[query]=${encodeURIComponent(q)}`);
  } catch {
    /* route warm optional */
  }

  const cid = await searchCollectionId(session);
  const pageSize = 100;
  let page = 1;
  let totalPages = 1;
  let merged = [];

  while (page <= totalPages) {
    const params = new URLSearchParams({
      include: 'default',
      decorators: DECORATORS,
      'page[items.size]': String(pageSize),
      'page[items.number]': String(page),
    });
    params.set('pf[query]', q);

    status(`Search "${q}" (page ${page}${totalPages > 1 ? `/${totalPages}` : ''})...`);
    const json = await cmsGet(session, `/cms/collections/${cid}`, params.toString());
    const meta = json.meta || {};
    totalPages = Math.max(1, Number(meta.itemsTotalPages) || 1);
    const totalResults = meta.itemsTotalResults ?? meta.itemsTotalCount;
    const { items } = parseCollectionItems(json);
    merged = merged.concat(items);
    if (page === 1 && totalResults != null) {
      status(`HBO Max reports ${totalResults} result(s) for "${q}"`);
    }
    if (!items.length || page >= totalPages) break;
    page += 1;
  }

  merged = dedupeBrowseItems(merged);
  const needLookup = merged.filter((i) => i._needsEditLookup);
  if (needLookup.length) {
    status(`Resolving playback IDs for ${needLookup.length} title(s)...`);
  }
  return hydrateShowEditIds(session, merged);
}

function collectionItemsFromRouteJson(json, collectionId) {
  const included = json?.included || [];
  const col = included.find((r) => r.id === collectionId && r.type === 'collection')
    || (json?.data?.id === collectionId ? json.data : null);
  if (!col?.relationships?.items?.data?.length) return [];
  return parseCollectionItems({ data: col, included }).items;
}

async function cmsRouteFetch(session, routePath, extraQuery = '') {
  const path = String(routePath || '').replace(/^\//, '');
  const params = new URLSearchParams({
    include: 'default',
    decorators: DECORATORS,
    'page[items.size]': '100',
  });
  const q = extraQuery ? (extraQuery.startsWith('&') ? extraQuery.slice(1) : extraQuery) : '';
  if (q) {
    for (const part of q.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq > 0) params.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
    }
  }
  return cmsGet(session, `/cms/routes/${path}`, params.toString());
}

function displayCollectionTitle(col) {
  const attrs = col?.attributes || {};
  if (attrs.title) return String(attrs.title);
  const alias = String(attrs.alias || attrs.name || '');
  if (/rail-live$/i.test(alias)) return 'Live';
  if (/rail-latest$/i.test(alias)) return 'Latest';
  if (/rail-upcoming$/i.test(alias)) return 'Upcoming';
  if (/rail-hero$/i.test(alias) || /inline-hero/i.test(alias)) return 'Featured';
  if (/themed-rail/i.test(alias)) return 'Featured event';
  if (/documentaries/i.test(alias)) return 'Documentaries';
  if (/premier-league/i.test(alias)) return 'Premier League';
  if (/cricket/i.test(alias)) return 'Cricket';
  if (alias && !/sports-home-page-rail|page-rail|menu-item/i.test(alias)) {
    return alias.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const comp = attrs.component?.id || '';
  const byComp = {
    hero: 'Featured',
    '16-9': 'Videos',
    '2-3': 'Browse',
    nano: 'Quick picks',
    multilevel: 'Channels',
    'themed-rail': 'Featured event',
  };
  return byComp[comp] || 'Row';
}

async function cmsCollectionItems(session, collectionId, { onStatus, pageSize = 100, parentRoute = null } = {}) {
  const status = onStatus || (() => {});

  if (parentRoute) {
    const routeJson = await cmsRouteFetch(session, parentRoute);
    const fromRoute = collectionItemsFromRouteJson(routeJson, collectionId);
    if (fromRoute.length) {
      const merged = dedupeBrowseItems(fromRoute);
      if (merged.some((i) => i._needsEditLookup)) {
        status(`Resolving playback IDs for ${merged.filter((i) => i._needsEditLookup).length} title(s)...`);
      }
      return hydrateShowEditIds(session, merged);
    }
  }

  let page = 1;
  let totalPages = 1;
  let merged = [];

  while (page <= totalPages) {
    const params = new URLSearchParams({
      include: 'default',
      decorators: DECORATORS,
      'page[items.size]': String(pageSize),
      'page[items.number]': String(page),
    });
    const json = await cmsGet(session, `/cms/collections/${collectionId}`, params.toString());
    const meta = json.meta || {};
    totalPages = Math.max(1, Number(meta.itemsTotalPages) || 1);
    const { items } = parseCollectionItems(json);
    merged = merged.concat(items);
    if (!items.length || page >= totalPages) break;
    page += 1;
  }
  merged = dedupeBrowseItems(merged);
  if (merged.some((i) => i._needsEditLookup)) {
    status(`Resolving playback IDs for ${merged.filter((i) => i._needsEditLookup).length} title(s)...`);
  }
  return hydrateShowEditIds(session, merged);
}

function parsePageRails(json) {
  const included = json.included || [];
  const inc = new Map(included.map((r) => [r.id, r]));
  const page = included.find((r) => r.type === 'page')
    || (json.data?.type === 'page' ? json.data : null);
  const title = page?.attributes?.title || page?.attributes?.name || 'Browse';
  const rails = [];

  const pageItems = page?.relationships?.items?.data || [];
  for (const ref of pageItems) {
    const pi = inc.get(ref.id);
    const colId = pi?.relationships?.collection?.data?.id;
    const col = colId ? inc.get(colId) : null;
    if (!col) continue;

    const compId = col.attributes?.component?.id || '';
    const rail = {
      title: displayCollectionTitle(col),
      collectionId: col.id,
      componentId: compId,
      kind: col.attributes?.kind || '',
      inlineItems: null,
    };

    const { items } = parseCollectionItems({ data: col, included });
    if (items.length) rail.inlineItems = items;
    rails.push(rail);
  }

  return { title, rails };
}

async function cmsPageRails(session, routePath, extraQuery = '') {
  const json = await cmsRouteFetch(session, routePath, extraQuery);
  return parsePageRails(json);
}

async function cmsRoute(session, routePath) {
  const params = new URLSearchParams({
    include: 'default',
    decorators: DECORATORS,
    'page[items.size]': '50',
  });
  const json = await cmsGet(session, `/cms/routes/${routePath}`, params.toString());
  const { items } = parseCollectionItems(json);
  return hydrateShowEditIds(session, items);
}

module.exports = {
  cmsGet,
  cmsSearch,
  cmsRoute,
  cmsCollectionItems,
  cmsPageRails,
  cmsRouteFetch,
  collectionItemsFromRouteJson,
  displayCollectionTitle,
  parsePageRails,
  resolveEditIdForShow,
  searchCollectionId,
  parseCollectionItems,
  hydrateShowEditIds,
  dedupeBrowseItems,
  apiRequestJson: requestJson,
};
