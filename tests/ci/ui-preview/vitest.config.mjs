import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));

export default {
    root,
    cacheDir: path.join(os.tmpdir(), 'touchai-ui-preview-vite'),
    test: {
        environment: 'node',
        include: ['tests/ci/ui-preview/**/*.test.js'],
    },
};
