'use strict';

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function sanitizeSaveName(title) {
  return String(title || '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

module.exports = {
  quoteCmdArg,
  sanitizeSaveName,
};
