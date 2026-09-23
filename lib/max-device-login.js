'use strict';

const { apiRequestJson: requestJson } = require('./max-cms');
const {
  bootstrap,
  saveSession,
  ensureDeviceIds,
  fetchAnonymousSt,
  sessionHeaders,
  sessionCookies,
  tokenIsAnonymous,
  resolveEndpoint,
} = require('./max-session');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenFromLoginJson(json) {
  return json?.data?.attributes?.token
    || json?.data?.attributes?.accessToken
    || json?.attributes?.token
    || null;
}

async function fetchUsersMe(session) {
  const url = resolveEndpoint(session.bootstrap, '/users/me')
    || `https://${session.apiHost}/users/me`;
  return requestJson(url, {
    headers: sessionHeaders(session),
    cookies: sessionCookies(session),
  });
}

async function usersMeIsSubscriber(session) {
  try {
    const me = await fetchUsersMe(session);
    const attrs = me?.data?.attributes || {};
    if (attrs.anonymous === true) return false;
    const state = String(attrs.registrationState || '').toUpperCase();
    if (state === 'ANONYMOUS') return false;
    return true;
  } catch {
    return false;
  }
}

async function ensureApiSession(onStatus) {
  const status = onStatus || (() => {});
  let session = ensureDeviceIds({});
  if (!session.st) {
    status('Getting HBO Max device session...');
    session.st = await fetchAnonymousSt(session.deviceUuid, session.installId);
  }
  if (!session.apiHost || !session.bootstrap) {
    status('Bootstrapping API...');
    const boot = await bootstrap(session.st, session.deviceUuid, session.installId);
    session = saveSession({
      ...session,
      apiHost: boot.apiHost,
      routing: boot.routing,
      bootstrap: boot.bootstrap,
    });
  }
  if (!session.accessToken) {
    session = saveSession({ ...session, accessToken: session.st });
  }
  return session;
}

async function signInViaDeviceLink({ onStatus, timeoutSec = 600 } = {}) {
  const status = onStatus || (() => {});
  let session = await ensureApiSession(status);

  const initiateUrl = resolveEndpoint(session.bootstrap, '/authentication/linkDevice/initiate');
  if (!initiateUrl) throw new Error('Could not resolve HBO Max device-link URL (bootstrap missing)');
  const initJson = await requestJson(initiateUrl, {
    method: 'POST',
    headers: sessionHeaders(session),
    cookies: sessionCookies(session),
    body: '{}',
  });
  const attrs = initJson?.data?.attributes || {};
  const code = attrs.linkingCode;
  const targetUrl = attrs.targetUrl || attrs.targetQRUrl || 'https://play.hbomax.com/link';
  if (!code) throw new Error('Device link failed — no linking code from HBO Max');

  console.log('');
  console.log('=== HBO Max device login ===');
  console.log(`Open: ${targetUrl}`);
  console.log(`Enter code: ${code}`);
  console.log('(Waiting up to 10 minutes...)');
  console.log('');

  const loginUrl = resolveEndpoint(session.bootstrap, '/authentication/linkDevice/login');
  const deadline = Date.now() + timeoutSec * 1000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    if (attempt % 6 === 0) status('Still waiting for device link on play.hbomax.com...');

    try {
      const loginJson = await requestJson(loginUrl, {
        method: 'POST',
        headers: sessionHeaders(session),
        cookies: sessionCookies(session),
        body: '{}',
      });
      const token = tokenFromLoginJson(loginJson);
      if (token && !tokenIsAnonymous(token)) {
        session = saveSession({
          ...session,
          accessToken: token.replace(/^Bearer\s+/i, ''),
          st: token.replace(/^Bearer\s+/i, ''),
        });
        if (await usersMeIsSubscriber(session)) {
          status('Device link OK — subscribed HBO Max session saved');
          return session;
        }
      }
    } catch (err) {
      if (err.status && err.status !== 204 && err.status !== 404) {
        // 204 = not linked yet
      }
    }
    await sleep(5000);
  }

  throw new Error('Device link timed out — open play.hbomax.com/link and enter the code, then run again');
}

module.exports = {
  signInViaDeviceLink,
  fetchUsersMe,
  usersMeIsSubscriber,
};
