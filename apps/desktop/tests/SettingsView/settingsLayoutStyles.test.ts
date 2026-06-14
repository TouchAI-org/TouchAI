import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const tailwindCss = readFileSync(resolve(__dirname, '../../src/styles/tailwind.css'), 'utf8');

function componentClassBody(className: string): string {
    const match = tailwindCss.match(new RegExp(`\\.${className}\\s*\\{\\s*([^}]+)\\}`));
    return match?.[1] ?? '';
}

describe('settings layout styles', () => {
    it('centers standard settings panels in wide windows', () => {
        const body = componentClassBody('settings-page');

        expect(body).toContain('width: min(1000px, calc(100% - 136px));');
        expect(body).toContain('margin-inline: auto;');
        expect(body).not.toContain('ml-20');
        expect(body).not.toContain('mr-14');
    });

    it('keeps a generous horizontal gutter for standard settings panels before mobile widths', () => {
        const body = componentClassBody('settings-page');

        expect(body).not.toContain('px-0');
        expect(body).not.toContain('px-6');
        expect(body).not.toContain('lg:px-0');
    });

    it('falls back to compact gutters only on very narrow settings windows', () => {
        expect(tailwindCss).toContain('@media (max-width: 760px)');
        expect(tailwindCss).toContain('width: calc(100% - 48px);');
    });

    it('lets settings page headers span the full panel width for right-aligned controls', () => {
        const body = componentClassBody('settings-page-header');

        expect(body).toContain('w-full');
        expect(body).not.toContain('max-w-2xl');
    });
});
