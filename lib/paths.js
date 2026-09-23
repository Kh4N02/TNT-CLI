'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');

function vendor(name) {
  return path.join(VENDOR, name);
}

function tokenFile() {
  return process.env.TNT_TOKEN_FILE || path.join(ROOT, 'tnt-token.json');
}

function browserProfile() {
  return process.env.TNT_BROWSER_PROFILE || path.join(ROOT, '.tnt-browser-profile');
}

module.exports = {
  ROOT,
  VENDOR,
  vendor,
  tokenFile,
  browserProfile,
};
