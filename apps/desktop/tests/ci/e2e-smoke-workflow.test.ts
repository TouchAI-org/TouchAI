import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../../..');

describe('desktop e2e smoke workflow', () => {
    it('sets WebView2 remote-debugging browser args for Windows CI', async () => {
        const workflow = await readFile(
            resolve(repositoryRoot, '.github/workflows/e2e-smoke.yml'),
            'utf8'
        );

        expect(workflow).toContain('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:');
        expect(workflow).toContain('--remote-debugging-port=0');
        expect(workflow).toContain('--no-sandbox');
        expect(workflow).toContain('Configure Edge WebDriver');
        expect(workflow).toContain('TOUCHAI_MSEDGEDRIVER_PATH=');
    });
});
