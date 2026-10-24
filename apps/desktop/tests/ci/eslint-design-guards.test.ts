// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ESLint 设计系统守卫的有效性测试。
 *
 * 只断言「配置里写了规则」是不够的：selector 写错时 ESLint 不会报错，只会静默地
 * 永不命中，于是守卫形同虚设而 CI 全绿。这里真的跑一遍 ESLint，用带违规的
 * fixture 证明规则会触发，再用干净代码证明它不会误报。
 *
 * 同时钉住一个容易踩的边界：ESLint 核心规则只遍历 `<script>`，看不到模板属性。
 * 因此本文件的用例全部针对脚本内的 class 字符串，模板里的漂移由
 * design-drift-budget 扫描原始文件文本兜住（见该脚本的测试）。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it, vi } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../../..');

/** Created once: constructing ESLint reloads the flat config and is slow on first use. */
const eslint = new ESLint({ cwd: repositoryRoot });

const lint = async (filePath: string, code: string) => {
    const results = await eslint.lintText(code, {
        filePath: resolve(repositoryRoot, filePath),
    });

    return results[0]?.messages ?? [];
};

const uiPrimitivePath = 'apps/desktop/src/components/ui/probe/Probe.vue';

const scriptWithClass = (classString: string) =>
    [
        '<script setup lang="ts">',
        `const probe = '${classString}';`,
        '</script>',
        '<template><div :class="probe">probe</div></template>',
        '',
    ].join('\n');

const restrictedMessages = (messages: Awaited<ReturnType<typeof lint>>) =>
    messages.filter((message) => message.ruleId === 'no-restricted-syntax');

describe('design-system ESLint guards on components/ui', () => {
    // The first lint call pays for loading the flat config and the Vue parser.
    vi.setConfig({ testTimeout: 30_000 });

    it('rejects an arbitrary hex colour in a cva class string', async () => {
        const messages = restrictedMessages(
            await lint(uiPrimitivePath, scriptWithClass('bg-[#f0f0ef]'))
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('Arbitrary hex colour');
    });

    it('rejects an arbitrary font size in a cva class string', async () => {
        const messages = restrictedMessages(
            await lint(uiPrimitivePath, scriptWithClass('text-[13px]'))
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('Arbitrary font size');
    });

    it('rejects an arbitrary radius in a cva class string', async () => {
        const messages = restrictedMessages(
            await lint(uiPrimitivePath, scriptWithClass('rounded-[9px]'))
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('Arbitrary radius');
    });

    it('rejects text-black', async () => {
        const messages = restrictedMessages(
            await lint(uiPrimitivePath, scriptWithClass('text-black'))
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('text-black');
    });

    it('rejects an arbitrary hex colour inside a template literal', async () => {
        const code = [
            '<script setup lang="ts">',
            'const base = `bg-[#ececea]`;',
            '</script>',
            '<template><div :class="base">probe</div></template>',
            '',
        ].join('\n');

        const messages = restrictedMessages(await lint(uiPrimitivePath, code));

        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('template literal');
    });

    it('reports every violation when several appear in one string', async () => {
        const messages = restrictedMessages(
            await lint(uiPrimitivePath, scriptWithClass('bg-[#ececea] text-[12px]'))
        );

        expect(messages.length).toBeGreaterThanOrEqual(2);
    });

    it('accepts token-based classes', async () => {
        const messages = restrictedMessages(
            await lint(
                uiPrimitivePath,
                scriptWithClass('bg-surface-sunken text-compact rounded-control text-text-primary')
            )
        );

        expect(messages).toEqual([]);
    });

    it('does not fire on built-in Tailwind scale utilities', async () => {
        const messages = restrictedMessages(
            await lint(uiPrimitivePath, scriptWithClass('rounded-lg text-sm bg-white p-4'))
        );

        // bg-white is tracked by the drift budget, not by ESLint.
        expect(messages).toEqual([]);
    });

    it('does not apply the rules outside components/ui yet', async () => {
        // Phase 1 covers the primitive layer only. The rest of the tree is held by
        // the drift budget, which permits the existing backlog to shrink but not grow.
        const messages = restrictedMessages(
            await lint(
                'apps/desktop/src/views/SearchView/probe/Probe.vue',
                scriptWithClass('bg-[#f0f0ef]')
            )
        );

        expect(messages).toEqual([]);
    });
});
