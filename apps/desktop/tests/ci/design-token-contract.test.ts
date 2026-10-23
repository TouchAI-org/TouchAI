import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    collectThemeTokens,
    evaluateTokenContract,
    findUnresolvedColorUtilities,
} from '../../scripts/ci/design-token-contract.mjs';

let fixtureRoot: string;

beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'design-token-contract-'));
});

afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeComponent(name: string, source: string) {
    const directory = join(fixtureRoot, 'src');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name), source, 'utf8');
}

function writeStylesheet(source: string) {
    const directory = join(fixtureRoot, 'styles');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'tailwind.css'), source, 'utf8');
}

describe('collectThemeTokens', () => {
    it('collects custom properties declared inside @theme', () => {
        writeStylesheet(`
@theme {
    --color-primary-500: #6b5f54;
    --radius-md: 0.625rem;
    --font-mono: monospace;
}
`);

        const tokens = collectThemeTokens(join(fixtureRoot, 'styles'));

        expect(tokens.has('--color-primary-500')).toBe(true);
        expect(tokens.has('--radius-md')).toBe(true);
        expect(tokens.has('--font-mono')).toBe(true);
    });

    it('ignores declarations outside @theme', () => {
        writeStylesheet(`
:root {
    --duration-quick: 150ms;
}

@theme {
    --color-surface: #ffffff;
}
`);

        const tokens = collectThemeTokens(join(fixtureRoot, 'styles'));

        expect(tokens.has('--color-surface')).toBe(true);
        expect(tokens.has('--duration-quick')).toBe(false);
    });
});

describe('findUnresolvedColorUtilities', () => {
    const themeTokens = new Set(['--color-surface', '--color-primary-500', '--text-sm']);

    it('flags a colour utility whose token is missing', () => {
        writeComponent('Card.vue', '<template><div class="bg-card">x</div></template>');

        const findings = findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.token).toBe('bg-card');
    });

    it('accepts a colour utility whose token exists', () => {
        writeComponent('Card.vue', '<template><div class="bg-surface">x</div></template>');

        expect(findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'))).toEqual([]);
    });

    it('accepts Tailwind default palette colours', () => {
        writeComponent(
            'Card.vue',
            '<template><div class="bg-neutral-200 text-gray-700">x</div></template>'
        );

        expect(findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'))).toEqual([]);
    });

    it('accepts structural utilities that share a colour prefix', () => {
        writeComponent(
            'Card.vue',
            '<template><div class="border-b border-b-2 divide-y outline-2 outline-offset-2 text-left text-sm">x</div></template>'
        );

        expect(findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'))).toEqual([]);
    });

    it('resolves a colour that follows a border side modifier', () => {
        writeComponent(
            'Card.vue',
            '<template><div class="border-t-primary-500">x</div></template>'
        );

        expect(findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'))).toEqual([]);
    });

    it('flags a colour after a border side modifier when its token is missing', () => {
        writeComponent('Card.vue', '<template><div class="border-t-card">x</div></template>');

        const findings = findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.token).toBe('border-card');
    });

    it('ignores arbitrary values, which the drift budget owns', () => {
        writeComponent(
            'Card.vue',
            '<template><div class="bg-[#f0f0ef] text-[13px]">x</div></template>'
        );

        expect(findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'))).toEqual([]);
    });

    it('strips variant prefixes before resolving', () => {
        writeComponent(
            'Card.vue',
            '<template><div class="hover:bg-surface focus:text-primary-500">x</div></template>'
        );

        expect(findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'))).toEqual([]);
    });

    it('strips an opacity suffix before resolving', () => {
        writeComponent('Card.vue', '<template><div class="bg-surface/50">x</div></template>');

        expect(findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'))).toEqual([]);
    });

    it('inspects string literals inside bound class expressions', () => {
        writeComponent(
            'Card.vue',
            `<template><div :class="['bg-hover', isActive ? 'bg-surface' : '']">x</div></template>`
        );

        const findings = findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'));

        expect(findings.map((finding) => finding.token)).toEqual(['bg-hover']);
    });

    it('reports the line number of the offending class', () => {
        writeComponent(
            'Card.vue',
            [
                '<template>',
                '  <div>',
                '    <span class="bg-missing">x</span>',
                '  </div>',
                '</template>',
            ].join('\n')
        );

        const findings = findUnresolvedColorUtilities(themeTokens, join(fixtureRoot, 'src'));

        expect(findings[0]?.line).toBe(3);
    });
});

describe('evaluateTokenContract', () => {
    it('returns an actionable message naming the utility and its location', () => {
        writeComponent('Card.vue', '<template><div class="bg-card">x</div></template>');

        const errors = evaluateTokenContract(new Set(), join(fixtureRoot, 'src'));

        expect(errors).toHaveLength(1);
        expect(errors[0] ?? '').toContain('bg-card');
        expect(errors[0] ?? '').toContain('Card.vue');
    });

    it('passes when every colour utility resolves', () => {
        writeComponent(
            'Card.vue',
            '<template><div class="bg-surface text-primary-500">x</div></template>'
        );

        expect(
            evaluateTokenContract(
                new Set(['--color-surface', '--color-primary-500']),
                join(fixtureRoot, 'src')
            )
        ).toEqual([]);
    });
});
