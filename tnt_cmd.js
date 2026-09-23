#!/usr/bin/env node
'use strict';

const readline = require('readline');
const {
  loadEnv,
  authenticate,
  sessionReadyForPlayback,
  loadCategories,
  getCategories,
  fetchSearch,
  formatLocalTime,
} = require('./lib/max-api');
const { resolveMaxPlayback } = require('./lib/max-playback');
const { resolveEditIdForShow } = require('./lib/max-cms');
const { fetchPageBrowseItems, fetchCollectionBrowseItems } = require('./lib/max-nav');
const { appendStreamHeader, appendSingleStream } = require('./lib/key-store');
const { launchNm3u8DlCommand } = require('./lib/tnt-launch-download');
const {
  printBanner,
  logInfo,
  logOk,
  logWarn,
  logErr,
  prompt,
  tnt,
  divider,
  C,
  colorEnabled,
} = require('./lib/ui');
const { renderTable } = require('./lib/table');

function ask(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt(promptText), (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}


function itemMenuRows(items) {
  return items.map((item, i) => ({
    Idx: String(i + 1),
    Status: item.status || '',
    Quality: item.quality || 'HD',
    Channel: item.channel || 'HBO Max',
    sport: item.channel,
    Title: item.title,
    'Local Time': formatLocalTime(item.start),
    'Edit ID': item.editId,
  }));
}

function categoryMenuRowsFor(list) {
  return list.map((c, i) => ({
    Idx: String(i + 1),
    Category: c.label,
    sport: c.label,
  }));
}

async function pickCategoryFrom(list, title = 'Select Category') {
  console.log('');
  console.log(renderTable(title, ['Idx', 'Category'], [
    ...categoryMenuRowsFor(list),
    { Idx: 'b', Category: 'Back', sport: '' },
    { Idx: 'q', Category: 'Quit', sport: '' },
  ]));
  console.log('');
  const choice = await ask('Select: ');
  if (choice.toLowerCase() === 'q') return 'quit';
  if (choice.toLowerCase() === 'b') return null;
  const idx = Number(choice);
  if (!Number.isInteger(idx) || idx < 1 || idx > list.length) {
    logErr('Invalid selection');
    return pickCategoryFrom(list, title);
  }
  return list[idx - 1];
}

async function pickCategory() {
  const picked = await pickCategoryFrom(getCategories(), 'HBO Max — Menu');
  if (picked === 'quit') process.exit(0);
  return picked;
}

async function pickRail(rails) {
  const rows = rails.map((r, i) => ({
    Idx: String(i + 1),
    Category: r.title,
    sport: r.componentId || '',
  }));
  console.log('');
  console.log(renderTable('Select row / rail', ['Idx', 'Category', 'sport'], [
    ...rows,
    { Idx: 'b', Category: 'Back', sport: '' },
  ]));
  const choice = await ask('Select rail: ');
  if (choice.toLowerCase() === 'b') return null;
  const idx = Number(choice);
  if (!Number.isInteger(idx) || idx < 1 || idx > rails.length) {
    logErr('Invalid selection');
    return pickRail(rails);
  }
  return idx - 1;
}

async function pickItem(items) {
  console.log('');
  console.log(renderTable('Events / Videos', ['Idx', 'Status', 'Quality', 'Channel', 'Title', 'Local Time', 'Edit ID'], [
    ...itemMenuRows(items),
    { Idx: 'b', Status: '', Quality: '', Channel: '', sport: '', Title: 'Back to categories', 'Local Time': '', 'Edit ID': '' },
    { Idx: 'q', Status: '', Quality: '', Channel: '', sport: '', Title: 'Quit', 'Local Time': '', 'Edit ID': '' },
  ]));
  console.log('');
  const choice = await ask('Select: ');
  if (choice.toLowerCase() === 'q') return 'quit';
  if (choice.toLowerCase() === 'b') return 'back';
  const idx = Number(choice);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    logErr('Invalid selection');
    return pickItem(items);
  }
  return items[idx - 1];
}

function printStream(result) {
  console.log(divider(`${result.cdnName} · HBO Max DASH`));
  console.log(colorEnabled() ? `${C.bold}MPD URL${C.reset}` : 'MPD URL');
  console.log(colorEnabled() ? `${C.dim}${result.manifestUrl}${C.reset}` : result.manifestUrl);
  console.log(colorEnabled() ? `${C.bold}License URL${C.reset}` : 'License URL');
  console.log(colorEnabled() ? `${C.dim}${result.licenseUrl}${C.reset}` : result.licenseUrl);
  console.log('');
  if (result.keys?.length) {
    logOk('Decryption keys');
    for (const k of result.keys) {
      console.log(colorEnabled()
        ? `  ${tnt('--key')} ${C.brightWhite}${k.kid}${C.reset}:${C.brightGreen}${k.key}${C.reset}`
        : `--key ${k.kid}:${k.key}`);
    }
    if (result.cmd) {
      console.log('');
      console.log(colorEnabled() ? `${C.bold}${tnt('N_m3u8DL-RE command')}${C.reset}` : 'N_m3u8DL-RE command:');
      console.log(colorEnabled() ? `${C.gray}${result.cmd}${C.reset}` : result.cmd);
    }
  } else {
    logWarn('No keys');
  }
  console.log('');
}

async function fetchStream(item, session) {
  logInfo(`Fetching playback for ${colorEnabled() ? tnt(item.title) : item.title}...`);
  let editId = item.editId;
  if (!editId && (item.showId || item._contentId)) {
    logInfo('Resolving playback ID...');
    try {
      editId = await resolveEditIdForShow(
        session,
        item.showId || item._contentId,
        item.videoType,
      );
    } catch (e) {
      logErr(e.message || String(e));
      return;
    }
  }
  if (!editId) {
    logErr('No playback ID for this title');
    return;
  }
  const keyFile = appendStreamHeader({ title: item.title });
  const result = await resolveMaxPlayback(session, editId, {
    onStatus: (msg) => logInfo(msg),
    displayTitle: item.title,
  });
  console.log('');
  logOk(`Title: ${result.title}`);
  for (const line of result.logs || []) {
    if (/Download proxy|Download direct|segment/i.test(line)) logInfo(line);
  }
  if (result.keysPatchedFromDiscovery > 0) {
    logOk(
      `Filled ${result.keysPatchedFromDiscovery} placeholder key(s) from Discovery+ Keys.txt`,
    );
  }
  console.log('');
  printStream(result);
  if (result.keys?.length) {
    appendSingleStream({
      stream: { keys: result.keys, cdnName: result.cdnName, manifestUrl: result.manifestUrl },
      index: 1,
    });
    logOk(`Saved keys to ${keyFile}`);
    if (result.cmd) {
      try {
        const launched = await launchNm3u8DlCommand(result.cmd, {
          title: result.title,
          manifestUrl: result.manifestUrl,
          downloadLaunch: result.downloadLaunch,
        });
        logOk(`Launched download — ${launched.batchPath}`);
      } catch (e) {
        logWarn(`Auto-launch skipped: ${e.message}`);
        logInfo('Copy the N_m3u8DL command above manually.');
      }
    }
  }
}

async function browseSubcategoryItems(items, session, sectionLabel) {
  if (!items.length) {
    logWarn(`No items found in "${sectionLabel}".`);
    return;
  }
  logOk(`Found ${items.length} item(s) in ${sectionLabel}`);
  for (;;) {
    const picked = await pickItem(items);
    if (picked === 'back') return;
    if (picked === 'quit') process.exit(0);
    if (picked.pageRoute) {
      await browsePageRoute({ label: picked.title, pageRoute: picked.pageRoute }, session);
      continue;
    }
    if (picked.collectionId && !picked.editId) {
      const sub = await fetchCollectionBrowseItems(session, picked.collectionId, {
        onStatus: (msg) => logInfo(msg),
        label: picked.title,
      });
      await browseSubcategoryItems(sub.items, session, sub.title);
      continue;
    }
    if (picked.browseOnly && !picked.editId) {
      logWarn(`“${picked.title}” is navigation only — pick a title with an Edit ID to download.`);
      continue;
    }
    try {
      await fetchStream(picked, session);
    } catch (e) {
      logErr(e.message || String(e));
    }
    const again = await ask('Press Enter for list, or b=back, q=quit: ');
    if (again.toLowerCase() === 'q') process.exit(0);
    if (again.toLowerCase() === 'b') return;
  }
}

async function browseSearch(session) {
  for (;;) {
    console.log('');
    const query = await ask('Search HBO Max (Enter = back): ');
    if (!query) return;
    logInfo(`Searching "${query}"...`);
    let items;
    try {
      items = await fetchSearch(query, session, (msg) => logInfo(msg));
    } catch (e) {
      logErr(e.message || String(e));
      continue;
    }
    const { usersMeIsSubscriber } = require('./lib/max-device-login');
    const subscribed = await usersMeIsSubscriber(session);
    if (!subscribed) {
      logWarn(
        'Not signed in to a subscribed HBO Max account — search is capped. '
        + 'Delete tnt-token.json, set TNT_DEVICE_LOGIN=1, run again, link at play.hbomax.com/link.',
      );
    } else if (items.length < 20 && query.toLowerCase() === 'england') {
      logWarn(
        `HBO Max API returned ${items.length} result(s) for "${query}" (site may show more rails/suggestions). `
        + 'If the website shows many more, delete tnt-token.json and link again with TNT_DEVICE_LOGIN=1.',
      );
    }
    await browseSubcategoryItems(items, session, `Search: ${query}`);
  }
}

async function browsePageRoute(category, session, sportContext = null) {
  let routePath = category.pageRoute;
  for (;;) {
    let result;
    try {
      result = await fetchPageBrowseItems(session, routePath, {
        onStatus: (msg) => logInfo(msg),
        sportContext,
      });
    } catch (e) {
      logErr(e.message || String(e));
      return;
    }

    while (result.needsRailPick && result.rails?.length) {
      logInfo(`${result.title}: ${result.rails.length} row(s) — pick one`);
      const railIdx = await pickRail(result.rails);
      if (railIdx == null) return;
      routePath = result.pageRoute || routePath;
      const hubSport = /\/sport-event\//i.test(routePath) ? null : sportContext;
      try {
        result = await fetchPageBrowseItems(session, routePath, {
          onStatus: (msg) => logInfo(msg),
          railIndex: railIdx,
          sportContext: hubSport,
        });
      } catch (e) {
        logErr(e.message || String(e));
        return;
      }
    }

    const items = result.items || [];
    if (!items.length && /cricket/i.test(result.title || category.label)) {
      logWarn(
        'HBO Max returned no cricket videos on this row (API empty). '
        + 'If the website still shows matches, delete tnt-token.json and re-link with TNT_DEVICE_LOGIN=1.',
      );
    }
    await browseSubcategoryItems(items, session, result.title || category.label);
    return;
  }
}

async function browseCategory(category, session) {
  if (category.isSearch) return browseSearch(session);

  if (category.subCategories?.length) {
    for (;;) {
      const sub = await pickCategoryFrom(category.subCategories, category.label);
      if (sub === 'quit') process.exit(0);
      if (!sub) return;
      await browsePageRoute(sub, session);
    }
    return;
  }

  if (category.pageRoute) {
    return browsePageRoute(category, session);
  }

  logErr('Unknown category type');
}

async function main() {
  loadEnv();
  printBanner();
  logInfo('Authenticating with HBO Max (UK / TNT Sports)...');
  let session;
  try {
    session = await authenticate((msg) => logInfo(msg));
    logOk('Successfully authenticated!');
    logInfo(`API host: ${session.apiHost || 'unknown'}`);
    if (!(await sessionReadyForPlayback(session))) {
      logWarn('Guest session: search/browse works; downloads need a subscribed login (TNT_DEVICE_LOGIN=1 → play.hbomax.com/link).');
    }
  } catch (e) {
    logErr(e.message || String(e));
    process.exit(1);
  }

  try {
    await loadCategories(session, (msg) => logInfo(msg));
  } catch (e) {
    logWarn(`Categories: ${e.message || e}`);
  }

  for (;;) {
    const category = await pickCategory();
    if (!category) {
      console.log(colorEnabled() ? `\n${tnt('Bye.')}\n` : '\nBye.\n');
      break;
    }
    await browseCategory(category, session);
  }
}

main().catch((e) => {
  logErr(e.message || String(e));
  process.exit(1);
});
