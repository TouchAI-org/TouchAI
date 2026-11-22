import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/result-export',
    testMatch: '**/*.export.ts',
    outputDir: join(tmpdir(), 'touchai-result-export-playwright'),
    workers: 2,
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    reporter: 'list',
    use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        headless: true,
    },
});
