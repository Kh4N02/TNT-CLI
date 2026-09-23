'use strict';
const { loadEnv } = require('../lib/max-api');
const { loadSession, bootstrap } = require('../lib/max-session');

loadEnv();
(async () => {
  const s = loadSession();
  const boot = await bootstrap(s.st, s.deviceUuid, s.installId);
  console.log(JSON.stringify(boot.bootstrap?.endpoints?.slice?.(0, 8) || boot, null, 2).slice(0, 5000));
})();
