import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function readRepositoryFile(path: string): string {
    return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('user sees one shadow gutter contract across the window stack', () => {
    it('user gets the same 24px gutter in native, popup, E2E and preview geometry', () => {
        expect(readRepositoryFile('apps/desktop/src-tauri/src/core/window/mod.rs')).toMatch(
            /WINDOW_SHADOW_GUTTER:\s*f64\s*=\s*24\.0\s*;/
        );
        expect(readRepositoryFile('apps/desktop/src/services/PopupService/types.ts')).toMatch(
            /POPUP_WINDOW_GUTTER\s*=\s*24\s*;/
        );
        expect(readRepositoryFile('apps/desktop/e2e-tests/test/support/desktop.js')).toMatch(
            /SEARCH_WINDOW_SHADOW_GUTTER\s*=\s*24\s*;/
        );
        expect(readRepositoryFile('.github/ui-preview/lib/profile.mjs')).toMatch(
            /WINDOW_SHADOW_GUTTER\s*=\s*24\s*;/
        );
    });

    it('user gets the same gutter from the shared window frame CSS', () => {
        const tailwindCss = readRepositoryFile('apps/desktop/src/styles/tailwind.css');

        expect(tailwindCss).toMatch(/\.window-frame\s*\{[^}]*@apply\s+p-6\s*;/s);
        expect(tailwindCss).toMatch(
            /:root\[data-window-maximized='true'\]\s+\.window-frame\s*\{[^}]*@apply\s+p-0\s*;/s
        );
    });
});
