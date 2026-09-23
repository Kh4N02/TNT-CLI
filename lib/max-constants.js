'use strict';

const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const SITE_ORIGIN = 'https://play.hbomax.com';
const TOKEN_HOST = 'default.any-any.prd.api.hbomax.com';
const DISCO_CLIENT = process.env.TNT_DISCO_CLIENT || 'WEB:10.15.7:dotcom-hbomax:7.7.0';
const DISCO_PARAMS = process.env.TNT_DISCO_PARAMS || 'realm=bolt,bid=beam,features=ar';

function deviceId() {
  const fromEnv = String(process.env.TNT_DEVICE_ID || '').trim();
  if (fromEnv) return fromEnv;
  return crypto.randomUUID();
}

function deviceInfo(deviceUuid, installId) {
  const dev = deviceUuid || deviceId();
  const inst = installId || crypto.randomUUID();
  return `beam/5.0.0 (desktop/desktop; Windows/10; ${dev}/${inst})`;
}

function discoHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-GB,en;q=0.9',
    Origin: SITE_ORIGIN,
    Referer: `${SITE_ORIGIN}/`,
    'x-disco-client': DISCO_CLIENT,
    'x-disco-params': DISCO_PARAMS,
    'x-wbd-preferred-language': 'en-GB',
    'x-wbd-time-zone': 'Europe/London',
    ...extra,
  };
}

module.exports = {
  UA,
  SITE_ORIGIN,
  TOKEN_HOST,
  DISCO_CLIENT,
  DISCO_PARAMS,
  deviceId,
  deviceInfo,
  discoHeaders,
};
