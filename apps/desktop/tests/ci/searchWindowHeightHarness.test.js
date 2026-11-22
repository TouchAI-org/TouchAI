import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';

import { createSearchWindowHeightPlugins } from '../layout/searchWindowHeight.vite.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('user runs the search-window layout harness', () => {
    it('user sees application icons resolved when the harness builds', async () => {
        const server = await createServer({
            configFile: false,
            root: desktopRoot,
            logLevel: 'silent',
            plugins: createSearchWindowHeightPlugins({ name: 'height-probe' }, desktopRoot),
            server: { middlewareMode: true },
            appType: 'custom',
        });

        try {
            const { appIconMap } = await server.ssrLoadModule('/src/components/appIconMap.ts');

            expect(appIconMap['arrow-down']).toBeDefined();
        } finally {
            await server.close();
        }
    });
});
