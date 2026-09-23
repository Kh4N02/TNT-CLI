'use strict';

require('../lib/max-api').loadEnv();
const s = require('../lib/max-session').loadSession();
const { resolveEditIdForShow } = require('../lib/max-cms');

(async () => {
  const id = '0e03cb4b-546b-4c49-a46a-25458223c859';
  console.log(await resolveEditIdForShow(s, id));
})().catch((e) => console.error(e.message));
