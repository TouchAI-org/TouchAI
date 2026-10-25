import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The product serif font is loaded from the Tauri asset protocol at runtime.
 *
 * `src/utils/font.ts` builds the URL with `convertFileSrc`, which resolves to
 * `http://asset.localhost/<path>` on Windows. A CSP source list matches by scheme
 * and origin, and `asset:` does not match an `http://` origin, so a `font-src` that
 * lists only `asset:` blocks the font even though the request itself is served.
 *
 * That failure is silent: the app renders, nothing logs an error a user would see,
 * and every `font-serif` element falls back to a generic face (Times New Roman on
 * Windows). This test pins the token that fixes it.
 */
describe('Tauri CSP font source', () => {
    async function readFontSrc(): Promise<string> {
        const configPath = join(process.cwd(), 'src-tauri', 'tauri.conf.json');
        const config = JSON.parse(await readFile(configPath, 'utf8')) as {
            app?: { security?: { csp?: Record<string, string> } };
        };

        return config.app?.security?.csp?.['font-src'] ?? '';
    }

    it('user sees the interface font because the asset protocol origin is allowed', async () => {
        const fontSrc = await readFontSrc();

        expect(fontSrc, 'font-src must be declared').not.toBe('');
        expect(
            fontSrc.split(/\s+/),
            'the asset protocol resolves to http://asset.localhost, which the asset: scheme alone does not match'
        ).toContain('http:');
    });

    it('keeps the sources the app already relied on', async () => {
        const tokens = new Set((await readFontSrc()).split(/\s+/).filter(Boolean));

        expect(tokens.has("'self'")).toBe(true);
        expect(tokens.has('data:')).toBe(true);
        expect(tokens.has('asset:')).toBe(true);
    });
});
