// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * Widget 主题契约守卫。
 *
 * `show-widget` 工具让模型按一套固定变量名生成 HTML（见
 * prompts/show-widget/core_design_system.md）。这套变量曾经有 20 个在
 * `@theme` 里根本不存在，全靠 runtimeConstants.ts 的硬编码兜底，于是 widget 和
 * 宿主界面成了两套设计语言：
 *
 *   文字主色  #2c2c2a（widget） vs #4a4039（宿主，暖棕）
 *   圆角 md   8px（widget）        vs 10px（宿主）
 *   等宽字体  第 3 份硬编码栈
 *
 * 现在这些名字都在 semantic 层有真实定义。这个测试守住两件事：
 *   1. 每个契约变量都能在 token 层解析到，否则 widget 会静默退回硬编码值；
 *   2. 兜底值与 token 值一致，否则兜底一旦生效就会出现视觉分叉。
 *
 * 它不检查渲染结果（那需要真实浏览器），只检查契约本身——而契约漂移正是
 * 之前出问题的地方。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    SHOW_WIDGET_COLOR_RAMPS,
    SHOW_WIDGET_THEME_FALLBACKS,
} from '@services/BuiltInToolService/tools/widgetTool/showWidget/runtimeConstants';
import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const stylesDirectory = resolve(testDirectory, '../../src/styles');
const tokensDirectory = join(stylesDirectory, 'tokens');

function collectTokenDeclarations(): Map<string, string> {
    const declarations = new Map<string, string>();

    for (const file of readdirSync(tokensDirectory)) {
        if (!file.endsWith('.css')) {
            continue;
        }

        const source = readFileSync(join(tokensDirectory, file), 'utf8');
        for (const match of source.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/gm)) {
            const name = match[1];
            const value = match[2];
            if (name && value) {
                declarations.set(name, value.trim());
            }
        }
    }

    return declarations;
}

const tokenDeclarations = collectTokenDeclarations();

const ROOT_FONT_SIZE_PX = 16;

/**
 * Resolves a `var(--alias)` chain down to its literal value.
 *
 * The widget contract deliberately aliases some variables (`--border-radius-md:
 * var(--radius-control)`), so comparing a fallback against the raw declaration
 * would either skip the variable or compare against the string `var(...)`. Both
 * hide the failure this test exists to catch: a fallback that diverges from the
 * token it shadows.
 */
function resolveTokenValue(name: string, seen = new Set<string>()): string | null {
    if (seen.has(name)) {
        return null;
    }
    seen.add(name);

    const value = tokenDeclarations.get(name);
    if (!value) {
        return null;
    }

    const alias = value.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/);
    if (!alias?.[1]) {
        return value;
    }

    return resolveTokenValue(alias[1], seen);
}

/**
 * Normalises a CSS length so `0.625rem` and `10px` compare as equal.
 *
 * The root font size is 16px (the app never changes it), so this is exact for the
 * units the token layer uses. Non-length values are returned lowercased and
 * unchanged.
 */
function normalizeCssValue(value: string): string {
    const trimmed = value.trim().toLowerCase();
    const length = trimmed.match(/^(-?\d+(?:\.\d+)?)(px|rem|em)?$/);

    if (!length) {
        return trimmed;
    }

    const amount = Number(length[1]);
    const unit = length[2] ?? '';

    return unit === 'rem' || unit === 'em'
        ? `${Number((amount * ROOT_FONT_SIZE_PX).toFixed(4))}px`
        : `${Number(amount.toFixed(4))}px`;
}

describe('widget theme contract', () => {
    it('resolves every declared variable against a real token', () => {
        const unresolved = Object.keys(SHOW_WIDGET_THEME_FALLBACKS).filter(
            (name) => !tokenDeclarations.has(name)
        );

        expect(
            unresolved,
            `these widget variables have no token definition, so widgets would silently fall back to hardcoded values: ${unresolved.join(', ')}`
        ).toEqual([]);
    });

    it('keeps the colour ramps the prompt documents', () => {
        // The prompt names these nine ramps and their stops; a rename here would
        // break every generated diagram without any error.
        expect(Object.keys(SHOW_WIDGET_COLOR_RAMPS).sort()).toEqual([
            'amber',
            'blue',
            'coral',
            'gray',
            'green',
            'pink',
            'purple',
            'red',
            'teal',
        ]);
    });

    it('gives every ramp the seven documented stops', () => {
        for (const [name, ramp] of Object.entries(SHOW_WIDGET_COLOR_RAMPS)) {
            expect(Object.keys(ramp).sort(), `ramp ${name} has the wrong stops`).toEqual([
                '100',
                '200',
                '400',
                '50',
                '600',
                '800',
                '900',
            ]);
        }
    });

    it('uses six-digit hex for every ramp stop', () => {
        for (const [name, ramp] of Object.entries(SHOW_WIDGET_COLOR_RAMPS)) {
            for (const [stop, value] of Object.entries(ramp)) {
                expect(value, `${name}-${stop} is not a hex colour`).toMatch(/^#[0-9A-Fa-f]{6}$/);
            }
        }
    });
});

describe('widget contract fallbacks', () => {
    it('matches the token value for every colour fallback that is a literal', () => {
        const literals = Object.entries(SHOW_WIDGET_THEME_FALLBACKS).filter(
            ([, value]) => !value.startsWith('var(')
        );

        for (const [name, fallback] of literals) {
            const resolvedToken = resolveTokenValue(name);

            // A fallback with no resolvable token behind it is the failure the
            // sibling test reports; skipping here would hide it twice.
            expect(resolvedToken, `${name} has no resolvable token`).not.toBeNull();

            expect(normalizeCssValue(fallback), `${name} fallback differs from its token`).toBe(
                normalizeCssValue(resolvedToken!)
            );
        }
    });

    it('declares a radius alias for each of the three documented steps', () => {
        for (const name of ['--border-radius-md', '--border-radius-lg', '--border-radius-xl']) {
            expect(tokenDeclarations.has(name), `${name} missing from the token layer`).toBe(true);
        }
    });

    it('points the radius aliases at the app scale rather than repeating pixels', () => {
        expect(tokenDeclarations.get('--border-radius-md')).toBe('var(--radius-control)');
        expect(tokenDeclarations.get('--border-radius-lg')).toBe('var(--radius-card)');
        expect(tokenDeclarations.get('--border-radius-xl')).toBe('var(--radius-panel)');
    });
});
