// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ESLint 设计系统守卫的有效性测试。
 *
 * 只断言「配置里写了规则」是不够的：selector 写错时 ESLint 不会报错，只会静默地
 * 永不命中，于是守卫形同虚设而 CI 全绿。这里真的跑一遍 ESLint，用带违规的
 * fixture 证明每条规则会触发，再用干净代码证明它不会误报。
 *
 * 覆盖两半：
 * - 模板：`eslint-plugin-tailwindcss` 负责任意值和不存在的类，
 *   `vue/no-restricted-class` 负责合法但绕过语义 token 的调色板类。
 * - 脚本：`no-restricted-syntax` 负责 cva / 常量里的同一类问题，因为核心规则
 *   看不到模板属性，而 Tailwind 插件看不到脚本里的 class 字符串。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it, vi } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');

/** Created once: constructing ESLint reloads the flat config and is slow on first use. */
const eslint = new ESLint({ cwd: repositoryRoot });

const DESIGN_RULES = new Set([
    'no-restricted-syntax',
    'tailwindcss/no-arbitrary-value',
    'tailwindcss/no-custom-classname',
    'vue/no-restricted-class',
]);

const lint = async (code: string, filePath = templatePath) => {
    const results = await eslint.lintText(code, {
        filePath: resolve(repositoryRoot, filePath),
    });

    return (results[0]?.messages ?? []).filter((message) => DESIGN_RULES.has(message.ruleId ?? ''));
};

const viewPath = 'apps/desktop/src/views/SearchView/probe/Probe.vue';
const primitivePath = 'apps/desktop/src/components/ui/probe/Probe.vue';

const scriptWithClass = (classString: string) =>
    [
        '<script setup lang="ts">',
        `const probe = '${classString}';`,
        '</script>',
        '<template><div :class="probe">probe</div></template>',
        '',
    ].join('\n');

const templateWithClass = (classString: string) =>
    ['<template>', `    <div class="${classString}">probe</div>`, '</template>', ''].join('\n');

const templatePath = viewPath;

const ruleIds = (messages: Awaited<ReturnType<typeof lint>>) =>
    messages.map((message) => message.ruleId).sort();

describe('design-system ESLint guards', () => {
    // The first lint call pays for loading the flat config and the Vue parser.
    vi.setConfig({ testTimeout: 60_000 });

    it('rejects arbitrary values in template class attributes', async () => {
        const messages = await lint(templateWithClass('p-[13px] bg-[#f0f0ef]'));

        expect(ruleIds(messages)).toEqual([
            'tailwindcss/no-arbitrary-value',
            'tailwindcss/no-arbitrary-value',
        ]);
    });

    it('rejects arbitrary values in a bound class string', async () => {
        const messages = await lint(
            templateWithClass('').replace('class=""', `:class="'text-[13px]'"`)
        );

        expect(ruleIds(messages)).toEqual(['tailwindcss/no-arbitrary-value']);
    });

    it('rejects palette utilities in static template classes', async () => {
        const messages = await lint(templateWithClass('bg-white text-neutral-500'));

        expect(ruleIds(messages)).toEqual(['vue/no-restricted-class', 'vue/no-restricted-class']);
    });

    it('rejects palette utilities in bound template classes', async () => {
        const messages = await lint(
            templateWithClass('').replace(
                'class=""',
                `:class="{ 'bg-stone-100': true, 'text-black': false }"`
            )
        );

        expect(ruleIds(messages)).toEqual(['vue/no-restricted-class', 'vue/no-restricted-class']);
    });

    it('rejects palette utilities behind variants', async () => {
        const templateMessages = await lint(
            templateWithClass('hover:bg-white sm:text-neutral-500')
        );

        expect(ruleIds(templateMessages)).toEqual([
            'vue/no-restricted-class',
            'vue/no-restricted-class',
        ]);

        const scriptMessages = await lint(
            scriptWithClass('hover:bg-neutral-100 dark:text-black'),
            primitivePath
        );

        expect(ruleIds(scriptMessages)).toEqual(['no-restricted-syntax']);
    });

    it('rejects utilities that do not exist', async () => {
        const messages = await lint(templateWithClass('totally-unknown-class'));

        expect(ruleIds(messages)).toEqual(['tailwindcss/no-custom-classname']);
        expect(messages[0]?.message).toContain('totally-unknown-class');
    });

    it('accepts project component classes defined in @layer components', async () => {
        const messages = await lint(templateWithClass('settings-card t-panel'));

        expect(messages).toEqual([]);
    });

    it('accepts token-based template classes', async () => {
        const messages = await lint(
            templateWithClass('bg-surface-sunken text-compact rounded-control text-text-primary')
        );

        expect(messages).toEqual([]);
    });

    it('rejects arbitrary values in a cva class string', async () => {
        const messages = await lint(
            scriptWithClass('bg-[#f0f0ef] text-[13px] rounded-[9px]'),
            primitivePath
        );

        // One class string is one AST node, so ESLint reports once even when the
        // string contains several arbitrary values.
        expect(ruleIds(messages)).toEqual(['no-restricted-syntax']);
        expect(messages[0]?.message).toContain('Arbitrary value');
    });

    it('rejects palette utilities in a cva class string', async () => {
        const messages = await lint(scriptWithClass('bg-white text-neutral-500'), primitivePath);

        expect(ruleIds(messages)).toEqual(['no-restricted-syntax']);
        expect(messages[0]?.message).toContain('semantic token');
    });

    it('rejects arbitrary values inside a script template literal', async () => {
        const code = [
            '<script setup lang="ts">',
            'const base = `bg-[#ececea]`;',
            '</script>',
            '<template><div :class="base">probe</div></template>',
            '',
        ].join('\n');

        const messages = await lint(code, primitivePath);

        expect(ruleIds(messages)).toEqual(['no-restricted-syntax']);
        expect(messages[0]?.message).toContain('template literal');
    });

    it('accepts token-based script classes', async () => {
        const messages = await lint(
            scriptWithClass('bg-surface-sunken text-compact rounded-control text-text-primary'),
            primitivePath
        );

        expect(messages).toEqual([]);
    });
});
