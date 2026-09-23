'use strict';

const fs = require('fs');
const path = require('path');

const ZERO_KEY = '00000000000000000000000000000000';
const KEY_LINE = /--key\s+([0-9a-fA-F]{32})\s*:\s*([0-9a-fA-F]{32})/g;

function normalizeHex32(value) {
  return String(value || '').replace(/-/g, '').toLowerCase();
}

function discoveryKeysFilePath() {
  if (process.env.TNT_DISCOVERY_KEYS_FILE) {
    return path.resolve(process.env.TNT_DISCOVERY_KEYS_FILE);
  }
  return path.join(__dirname, '..', 'Discovery+ Keys.txt');
}

let cachedMap = null;
let cachedMtime = 0;
let cachedPath = '';

function loadDiscoveryKeyMap(filePath = discoveryKeysFilePath()) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return new Map();
  }
  const stat = fs.statSync(resolved);
  if (cachedMap && cachedPath === resolved && stat.mtimeMs === cachedMtime) {
    return cachedMap;
  }

  const text = fs.readFileSync(resolved, 'utf8');
  const map = new Map();
  for (const m of text.matchAll(KEY_LINE)) {
    const kid = normalizeHex32(m[1]);
    const key = normalizeHex32(m[2]);
    if (kid.length === 32 && key.length === 32 && key !== ZERO_KEY) {
      map.set(kid, key);
    }
  }

  cachedMap = map;
  cachedMtime = stat.mtimeMs;
  cachedPath = resolved;
  return map;
}

/**
 * Replace remote-CDM placeholder keys (all zeros) using Discovery+ Keys.txt (kid match).
 * @returns {{ keys: Array<{kid,key}>, patched: number, missingKids: string[], keyFile: string }}
 */
function patchZeroKeysFromDiscovery(keys, { keyFile } = {}) {
  const file = keyFile || discoveryKeysFilePath();
  const lookup = loadDiscoveryKeyMap(file);
  const out = [];
  let patched = 0;
  const missingKids = [];

  for (const entry of keys || []) {
    const kid = normalizeHex32(entry.kid);
    let key = normalizeHex32(entry.key);
    if (key === ZERO_KEY) {
      const replacement = lookup.get(kid);
      if (replacement) {
        key = replacement;
        patched += 1;
      } else {
        missingKids.push(kid);
      }
    }
    out.push({ kid, key });
  }

  return { keys: out, patched, missingKids, keyFile: file };
}

module.exports = {
  ZERO_KEY,
  discoveryKeysFilePath,
  loadDiscoveryKeyMap,
  patchZeroKeysFromDiscovery,
  normalizeHex32,
};
