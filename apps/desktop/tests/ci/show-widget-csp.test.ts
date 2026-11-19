import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS } from '@/app/api/tools/widgets';

describe('ShowWidget CSP', () => {
    it('user can load documented widget CDN scripts under the unchanged native policy', async () => {
        const configPath = join(process.cwd(), 'src-tauri', 'tauri.conf.json');
        const tauriConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
            app?: { security?: { csp?: { 'script-src'?: string } } };
        };
        const scriptSrc = tauriConfig.app?.security?.csp?.['script-src'] ?? '';
        const scriptSrcTokens = new Set(scriptSrc.split(/\s+/).filter(Boolean));

        for (const host of SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS) {
            expect(scriptSrcTokens.has(`https://${host}`)).toBe(true);
        }
    });
});
