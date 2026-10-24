// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * Token 数值守卫。
 *
 * 迁移到 token 之后，「视觉零变化」不再由调用点的字面值保证，而是由 token 的
 * 取值保证。这个测试把每个 token 的数值钉住：任何人改动 tokens/*.css 里的值，
 * 都会在这里看到明确的失败，而不是在某个页面里看到 1px 的偏移。
 *
 * 它同时守住分层边界：primitive 层不应出现语义名，semantic 层不应出现字面
 * 颜色值（必须 var() 指向 primitive）。这条边界是后续做暗色模式的前提。
 *
 * 位置说明：这里测的是 token 的取值本身，不涉及任何 CI 守卫脚本，所以放在
 * tests/styles/ 而不是 tests/ci/。tests/ci/ 下的设计系统测试都是守卫脚本的
 * 自测（drift 预算、token 契约、ESLint 规则），与这个文件无关。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const stylesDirectory = resolve(testDirectory, '../../src/styles');

const readStyle = (relativePath: string) =>
    readFileSync(resolve(stylesDirectory, relativePath), 'utf8');

const primitiveCss = readStyle('tokens/primitive.css');
const semanticCss = readStyle('tokens/semantic.css');

/** Reads a custom property declaration from a stylesheet body. */
function tokenValue(source: string, token: string): string | undefined {
    const match = source.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
    return match?.[1]?.trim();
}

function tokenNames(source: string): string[] {
    return [...source.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((match) => match[1] ?? '');
}

/**
 * Follows `var()` references until a literal is reached.
 *
 * A token may be declared in either layer, and a semantic role generally points
 * at a primitive. Resolving the chain is what lets the tests assert the colour
 * that actually renders, which is the property that matters.
 */
function resolveToken(...sources: string[]) {
    return (token: string, depth = 0): string | undefined => {
        if (depth > 8) {
            throw new Error(`var() chain too deep at ${token}`);
        }

        const declared = sources.map((source) => tokenValue(source, token)).find(Boolean);
        if (!declared) {
            return undefined;
        }

        const reference = declared.match(/^var\((--[a-zA-Z0-9-]+)\)$/);
        if (!reference) {
            return declared;
        }

        return resolveToken(...sources)(reference[1] ?? '', depth + 1);
    };
}

describe('primitive tokens', () => {
    it('declares a monospace family, so font-mono stops falling back', () => {
        const mono = tokenValue(primitiveCss, '--font-mono');

        expect(mono).toBeDefined();
        expect(mono).toContain('JetBrains Mono');
    });

    it('keeps the type steps that replace the arbitrary font sizes', () => {
        expect(tokenValue(primitiveCss, '--text-3xs')).toBe('9px');
        expect(tokenValue(primitiveCss, '--text-2xs')).toBe('10px');
        expect(tokenValue(primitiveCss, '--text-caption')).toBe('11px');
        /*
         * 12px has its own step rather than reusing Tailwind's `text-xs`, because
         * `text-xs` also sets a line-height (16px) while `text-[12px]` inherits.
         * The settings button relies on the inherited value; switching it to
         * `text-xs` made every settings button 16px tall instead of following its
         * own line box.
         */
        expect(tokenValue(primitiveCss, '--text-dense')).toBe('12px');
        expect(tokenValue(primitiveCss, '--text-compact')).toBe('13px');
        expect(tokenValue(primitiveCss, '--text-reading')).toBe('15px');
    });

    it('does not declare line heights for the custom type steps', () => {
        /*
         * Every step above must set font-size only. Declaring `--text-*--line-height`
         * would silently change element heights across the app, which is exactly
         * the regression `--text-dense` exists to avoid.
         */
        for (const step of [
            '3xs',
            '2xs',
            'caption',
            'dense',
            'compact',
            'reading',
            'subtitle',
            'title',
        ]) {
            expect(primitiveCss).not.toMatch(new RegExp(`--text-${step}--line-height`));
        }
    });

    it('keeps the radius values the existing call sites depend on', () => {
        // 62 call sites use rounded-lg; changing this value moves all of them.
        expect(tokenValue(primitiveCss, '--radius-lg')).toBe('0.75rem');
        expect(tokenValue(primitiveCss, '--radius-md')).toBe('0.625rem');
        expect(tokenValue(primitiveCss, '--radius-sm')).toBe('0.5rem');
        expect(tokenValue(primitiveCss, '--radius-control')).toBe('0.625rem');
        expect(tokenValue(primitiveCss, '--radius-action')).toBe('0.5625rem');
    });

    it('keeps the brand ramp the app was designed around', () => {
        expect(tokenValue(primitiveCss, '--color-primary-500')).toBe('#6b5f54');
        expect(tokenValue(primitiveCss, '--color-primary-700')).toBe('#4a4039');
    });

    it('contains no semantic role names', () => {
        const semanticRoleNames = [
            '--color-surface',
            '--color-canvas',
            '--color-card',
            '--color-text-primary',
            '--color-border-subtle',
            '--color-hover',
            '--color-active',
        ];

        for (const role of semanticRoleNames) {
            expect(tokenNames(primitiveCss)).not.toContain(role);
        }
    });
});

describe('semantic tokens', () => {
    it('resolves every surface role to the exact colour it replaced', () => {
        /*
         * The roles now point at the primitive neutral ladder rather than carrying
         * literals. Asserting the declared string would only prove the indirection
         * exists; what has to hold is the colour that lands on screen, so resolve
         * the var() chain and compare the final value.
         */
        const resolved = resolveToken(primitiveCss, semanticCss);

        expect(resolved('--color-surface-sunken')).toBe('#f0f0ef');
        expect(resolved('--color-surface-hover')).toBe('#f1f1ef');
        expect(resolved('--color-surface-hover-soft')).toBe('#eeeeec');
        expect(resolved('--color-surface-active')).toBe('#ececea');
        expect(resolved('--color-surface-active-strong')).toBe('#e2e2df');
        expect(resolved('--color-surface-selected')).toBe('#e9e9e7');
        expect(resolved('--color-canvas')).toBe('#f7f7f6');
        expect(resolved('--color-canvas-sunken')).toBe('#f4f4f2');
        expect(resolved('--color-surface-raised')).toBe('#f8f8f8');
    });

    it('routes every surface role through a primitive instead of a literal', () => {
        // The layer contract says semantic values point back at primitives. If a
        // role regains a literal, a palette change stops propagating.
        for (const role of [
            '--color-canvas',
            '--color-canvas-sunken',
            '--color-surface-raised',
            '--color-surface-sunken',
            '--color-surface-hover',
            '--color-surface-hover-soft',
            '--color-surface-active',
            '--color-surface-active-strong',
            '--color-surface-selected',
        ]) {
            expect(tokenValue(semanticCss, role), `${role} should be a var() reference`).toMatch(
                /^var\(--color-ui-\d+\)$/
            );
        }
    });

    it('defines the tokens that templates referenced while nothing declared them', () => {
        // bg-card / bg-hover / bg-active used to resolve only through a scoped
        // stylesheet. If these disappear the utilities silently stop working.
        expect(tokenValue(semanticCss, '--color-card')).toBeDefined();
        expect(tokenValue(semanticCss, '--color-hover')).toBeDefined();
        expect(tokenValue(semanticCss, '--color-active')).toBeDefined();
    });

    it('keeps the canvas and text colours the app already rendered', () => {
        expect(tokenValue(semanticCss, '--color-background')).toBe('#fbfbf6');
        expect(tokenValue(semanticCss, '--color-foreground')).toBe('#4a4039');
        expect(tokenValue(semanticCss, '--color-text-primary')).toBe('#4a4039');
    });

    it('points role colours at primitives instead of repeating literals', () => {
        // These three are the only semantic colours allowed to alias a ramp.
        expect(tokenValue(semanticCss, '--color-primary')).toBe('var(--color-primary-700)');
        expect(tokenValue(semanticCss, '--color-secondary')).toBe('var(--color-primary-100)');
        expect(tokenValue(semanticCss, '--color-accent')).toBe('var(--color-primary-100)');
        expect(tokenValue(semanticCss, '--color-ring')).toBe('var(--color-primary-300)');
    });
});

describe('token layering', () => {
    it('loads primitive before semantic, so aliases resolve', () => {
        const tailwindCss = readStyle('tailwind.css');
        const primitiveIndex = tailwindCss.indexOf('./tokens/primitive.css');
        const semanticIndex = tailwindCss.indexOf('./tokens/semantic.css');

        expect(primitiveIndex).toBeGreaterThan(-1);
        expect(semanticIndex).toBeGreaterThan(-1);
        expect(primitiveIndex).toBeLessThan(semanticIndex);
    });

    it('declares every token inside @theme, which is the only block that generates utilities', () => {
        // A token declared in :root produces no utility class and fails silently
        // when used as a class name, which is exactly the bug this structure fixes.
        //
        // The widget radius aliases are the deliberate exception: they are not
        // utilities, they are values the show-widget runtime reads and copies into
        // the widget host. They must stay out of @theme, and this test names them
        // explicitly rather than letting the rule grow a blanket ignore.
        const nonUtilityTokens = new Set([
            '--border-radius-md',
            '--border-radius-lg',
            '--border-radius-xl',
        ]);

        for (const [name, source] of [
            ['primitive', primitiveCss],
            ['semantic', semanticCss],
        ] as const) {
            const themeBlocks = [...source.matchAll(/@theme\s*\{([\s\S]*?)\n\}/g)];
            const themeBody = themeBlocks.map((block) => block[1]).join('\n');
            const declared = tokenNames(source);

            expect(declared.length, `${name} declares no tokens`).toBeGreaterThan(0);
            for (const token of declared) {
                if (nonUtilityTokens.has(token)) {
                    continue;
                }

                expect(themeBody, `${token} in ${name}.css is declared outside @theme`).toContain(
                    token
                );
            }
        }
    });

    it('keeps the widget radius aliases out of @theme', () => {
        // Declaring these in @theme would also generate rounded-md / rounded-lg /
        // rounded-xl utilities with widget values, colliding with the app scale.
        const themeBlocks = [...semanticCss.matchAll(/@theme\s*\{([\s\S]*?)\n\}/g)];
        const themeBody = themeBlocks.map((block) => block[1]).join('\n');

        for (const token of ['--border-radius-md', '--border-radius-lg', '--border-radius-xl']) {
            expect(semanticCss, `${token} missing from semantic.css`).toContain(token);
            expect(themeBody, `${token} must not be in @theme`).not.toContain(token);
        }
    });

    it('does not declare the same token twice across layers', () => {
        const primitiveNames = new Set(tokenNames(primitiveCss));
        const duplicates = tokenNames(semanticCss).filter((name) => primitiveNames.has(name));

        expect(duplicates).toEqual([]);
    });
});
