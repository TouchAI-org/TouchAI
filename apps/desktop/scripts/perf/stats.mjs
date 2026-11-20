import { pathToFileURL } from 'node:url';

import { generateStats } from './stats/generate.mjs';

export { generateStats };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    generateStats().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
