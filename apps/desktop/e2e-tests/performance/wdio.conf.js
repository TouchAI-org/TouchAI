import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as smokeConfig } from '../wdio.conf.js';

if (process.env.TOUCHAI_E2E_CARGO_PROFILE !== 'release' || !process.env.TOUCHAI_PERF_REPORT) {
    throw new Error('Lifecycle performance requires a release binary and an explicit report path.');
}

export const config = {
    ...smokeConfig,
    specs: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'lifecycle.e2e.js')],
    services: [],
    mochaOpts: { ui: 'bdd', timeout: 180000 },
};
