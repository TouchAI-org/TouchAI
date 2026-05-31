import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS } from '@/services/BuiltInToolService/tools/widgetTool';

describe('ShowWidget CSP', () => {
    it('allows documented widget CDN script hosts', async () => {
        const configPath = join(process.cwd(), 'src-tauri', 'tauri.conf.json');
        const tauriConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
            app?: { security?: { csp?: { 'script-src'?: string } } };
        };
        const scriptSrc = tauriConfig.app?.security?.csp?.['script-src'] ?? '';

        for (const host of SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS) {
            expect(scriptSrc).toContain(`https://${host}`);
        }
    });
});
