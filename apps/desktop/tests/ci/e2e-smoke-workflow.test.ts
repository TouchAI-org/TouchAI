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
        expect(workflow).toContain('--remote-debugging-port=9222');
        expect(workflow).toContain('msEdgeDevToolsWdpRemoteDebugging');
        expect(workflow).toContain('--no-sandbox');
        expect(workflow).toContain('Configure Edge WebDriver');
        expect(workflow).toContain('TOUCHAI_MSEDGEDRIVER_PATH=');
    });

    it('classifies merge_group changes from base/head instead of forcing desktop E2E', async () => {
        const workflow = await readFile(
            resolve(repositoryRoot, '.github/workflows/e2e-smoke.yml'),
            'utf8'
        );

        expect(workflow).toContain("context.eventName !== 'merge_group'");
        expect(workflow).toContain(
            "context.eventName === 'push' || context.eventName === 'merge_group'"
        );
        expect(workflow).toContain('context.payload.merge_group?.base_sha');
        expect(workflow).toContain('context.payload.merge_group?.head_sha');
    });
});
