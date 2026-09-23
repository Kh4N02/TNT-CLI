'use strict';

const readline = require('readline');
const { chromium } = require('playwright');
const { browserProfile } = require('./paths');
const { parseCustomProxy } = require('../vendor/proxy-parse');
const { SITE_ORIGIN, UA } = require('./max-constants');
const { bootstrap, saveSession, ensureDeviceIds, tokenIsAnonymous } = require('./max-session');

const AUTH_URLS = [
  'https://play.hbomax.com/profile/select',
  'https://play.hbomax.com',
  'https://www.hbomax.com',
  'https://auth.hbomax.com/login',
];

const WAIT_MS_HEADLESS = 3 * 60 * 1000;
const WAIT_MS_VISIBLE = 15 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEnter(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

function parseProxyForPlaywright(proxySpec) {
  const url = parseCustomProxy(proxySpec);
  if (!url) return null;
  const u = new URL(url);
  return {
    server: `${u.protocol}//${u.hostname}:${u.port}`,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

function tokenFromJson(json) {
  if (!json || typeof json !== 'object') return null;
  const paths = [
    json?.data?.attributes?.token,
    json?.data?.attributes?.accessToken,
    json?.attributes?.token,
    json?.access_token,
    json?.accessToken,
    json?.token,
  ];
  for (const t of paths) {
    if (typeof t === 'string' && t.length > 20) return t.replace(/^Bearer\s+/i, '');
  }
  return null;
}

async function dismissCookies(page) {
  for (const sel of [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("I Agree")',
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      try { await btn.click({ timeout: 2500 }); } catch { /* ignore */ }
    }
  }
}

async function pageHasBotChallenge(page) {
  const selectors = [
    'iframe[src*="arkose"]',
    'iframe[src*="funcaptcha"]',
    'iframe[title*="challenge"]',
    '#enforcement-frame',
    '[id*="arkose"]',
  ];
  for (const sel of selectors) {
    try {
      if (await page.locator(sel).count()) return true;
    } catch { /* ignore */ }
  }
  try {
    const text = await page.locator('body').innerText({ timeout: 3000 });
    if (/verify you are human|complete the puzzle|visual challenge|are you a robot/i.test(text)) return true;
  } catch { /* ignore */ }
  return false;
}

async function clickSignInIfNeeded(page, status) {
  for (const sel of [
    'a[href*="login"]',
    'button:has-text("Sign In")',
    'a:has-text("Sign In")',
    'button:has-text("Sign in")',
    'a:has-text("Sign in")',
  ]) {
    const btn = page.locator(sel).first();
    if (!(await btn.count())) continue;
    try {
      if (await btn.isVisible({ timeout: 2000 })) {
        status('Opening sign-in...');
        await btn.click({ timeout: 15000 });
        await page.waitForTimeout(2500);
        return;
      }
    } catch { /* try next */ }
  }
}

async function fillLoginForm(page, email, password, status) {
  status('Entering email & password (puzzle may appear — Chrome will stay open)...');

  const emailInput = page.locator(
    'input[type="email"], input[name="email"], input#username, input[name="username"], input[autocomplete="username"]',
  ).first();
  await emailInput.waitFor({ state: 'visible', timeout: 90000 });
  await emailInput.fill(email);
  await page.waitForTimeout(400);

  const continueBtn = page.locator(
    'button[type="submit"]:visible, button:has-text("Continue"):visible, button:has-text("Next"):visible',
  ).first();
  if (await continueBtn.count()) {
    await continueBtn.click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  if (await pageHasBotChallenge(page)) {
    status('Verification puzzle shown — solve it in Chrome (no rush).');
    return;
  }

  const passInput = page.locator('input[type="password"]:visible').first();
  try {
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    await passInput.fill(password);
    await page.waitForTimeout(400);
    const submit = page.locator(
      'button[type="submit"]:visible, button:has-text("Sign in"):visible, button:has-text("Sign In"):visible',
    ).first();
    await submit.click({ timeout: 20000 }).catch(() => {});
  } catch {
    status('Password step waiting — finish email/puzzle in Chrome if needed.');
  }
}

async function readStCookie(ctx) {
  const cookies = await ctx.cookies();
  const stCookie = cookies.find((c) => c.name === 'st' && c.value);
  return stCookie ? stCookie.value : null;
}

async function pollForSession(ctx, page, capture, { deadline, status, useHeadless }) {
  let captchaMsg = false;

  while (Date.now() < deadline) {
    capture.stFromBrowser = await readStCookie(ctx) || capture.stFromBrowser;

    for (const p of ctx.pages()) {
      if (await pageHasBotChallenge(p)) {
        if (!captchaMsg) {
          captchaMsg = true;
          const mins = Math.round((deadline - Date.now()) / 60000);
          status(`Bot puzzle active — Chrome stays open (~${mins} min left). Complete it, then HBO Max home.`);
        }
      }
    }

    if (capture.accessToken && capture.stFromBrowser && !tokenIsAnonymous(capture.accessToken)) {
      return true;
    }

    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/incorrect|invalid email|invalid password|try again/i.test(bodyText)) {
      throw new Error('HBO Max rejected email or password — check TNT_EMAIL / TNT_PASSWORD in .env (quote # in passwords)');
    }

    await sleep(2000);
  }

  return Boolean(
    capture.accessToken
    && capture.stFromBrowser
    && !tokenIsAnonymous(capture.accessToken),
  );
}

async function signInViaBrowser({ email, password, proxySpec, onStatus, headless }) {
  const status = onStatus || (() => {});
  const proxy = parseProxyForPlaywright(proxySpec);
  if (!proxy) throw new Error('Invalid TNT_PROXY for browser sign-in');

  const capture = {
    accessToken: null,
    sessionState: null,
    stFromBrowser: null,
    loginError: null,
  };

  const useHeadless = headless != null
    ? headless
    : process.env.TNT_BROWSER_HEADLESS === '1';

  const manualOnly = process.env.TNT_MANUAL_LOGIN === '1';

  const ctx = await chromium.launchPersistentContext(browserProfile(), {
    headless: useHeadless,
    channel: 'chrome',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    proxy,
    viewport: { width: 1280, height: 720 },
    userAgent: UA,
  });

  const attachListeners = (page) => {
    page.on('response', async (r) => {
      const url = r.url();
      if (!/hbomax\.com|discomax\.com|wbd\.com|bolt\.com/i.test(url)) return;

      const reqAuth = r.request().headers().authorization || r.request().headers().Authorization;
      if (reqAuth && /^Bearer\s+/i.test(reqAuth)) {
        capture.accessToken = reqAuth.replace(/^Bearer\s+/i, '');
      }

      const ss = r.request().headers()['x-wbd-session-state'];
      if (ss) capture.sessionState = ss;

      if (r.status() !== 200 && r.status() !== 201) return;
      try {
        const ct = r.headers()['content-type'] || '';
        if (!/json/i.test(ct)) return;
        const json = await r.json();
        const t = tokenFromJson(json);
        if (t) capture.accessToken = t;
      } catch { /* ignore */ }
    });

    page.on('pageerror', (err) => {
      capture.loginError = capture.loginError || String(err.message || err);
    });
  };

  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    attachListeners(page);
    ctx.on('page', (p) => attachListeners(p));

    status(useHeadless
      ? 'Opening HBO Max in headless Chrome...'
      : 'Opening HBO Max in Chrome — keep this window open until login finishes.');

    let loaded = false;
    for (const url of AUTH_URLS) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        loaded = true;
        break;
      } catch {
        status(`Retrying — could not load ${url}`);
      }
    }
    if (!loaded) throw new Error('Could not load HBO Max in Chrome (check TNT_PROXY / VPN)');

    await dismissCookies(page);

    if (manualOnly) {
      status('Manual login: sign in (and complete any puzzle) in Chrome, then press Enter here...');
      await waitForEnter('\nPress Enter when HBO Max home/profile is loaded: ');
    } else {
      await clickSignInIfNeeded(page, status);
      await dismissCookies(page);
      const active = page.url().includes('auth.')
        ? page
        : ctx.pages().find((p) => /auth\.hbomax/i.test(p.url())) || page;
      await fillLoginForm(active, email, password, status);
    }

    const waitMs = useHeadless ? WAIT_MS_HEADLESS : WAIT_MS_VISIBLE;
    status(`Waiting for login (up to ${Math.round(waitMs / 60000)} min — Chrome will not close early)...`);

    let ok = await pollForSession(ctx, page, capture, {
      deadline: Date.now() + waitMs,
      status,
      useHeadless,
    });

    if (!ok && !useHeadless) {
      status('Still waiting — finish the puzzle in Chrome, reach HBO Max home, then press Enter.');
      await waitForEnter('\nPress Enter when you are signed in: ');
      ok = await pollForSession(ctx, page, capture, {
        deadline: Date.now() + 10 * 60 * 1000,
        status,
        useHeadless,
      });
    }

    capture.stFromBrowser = capture.stFromBrowser || await readStCookie(ctx);

    if (!ok || !capture.stFromBrowser) {
      throw new Error(
        `Login not detected yet. ${useHeadless ? 'Run without headless: remove TNT_BROWSER_HEADLESS or set to 0.' : 'Try again — puzzle must finish before Chrome closes.'} ${capture.loginError || ''}`.trim(),
      );
    }

    let session = ensureDeviceIds({});

    status('Bootstrapping API routing...');
    const boot = await bootstrap(capture.stFromBrowser, session.deviceUuid, session.installId);

    session = saveSession({
      st: capture.stFromBrowser,
      accessToken: capture.accessToken || undefined,
      sessionState: capture.sessionState,
      apiHost: boot.apiHost,
      routing: boot.routing,
      bootstrap: boot.bootstrap,
      deviceUuid: session.deviceUuid,
      installId: session.installId,
    });

    if (!session.accessToken) {
      status('Session saved — browsing may still work; if search fails, sign in again with TNT_MANUAL_LOGIN=1');
    } else {
      status('Login OK — session saved to tnt-token.json');
    }

    return session;
  } finally {
    await ctx.close();
  }
}

module.exports = { signInViaBrowser };
