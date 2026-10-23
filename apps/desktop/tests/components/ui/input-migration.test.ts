// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * 迁移等价性验证：`.settings-input` 自研类 → Input variant="filled"。
 *
 * 这个测试存在的理由与 button-migration.test.ts 相同：`.settings-input` 定义在
 * @layer components，优先级低于 utilities 层，因此调用点附加的 px-4 py-2.5 /
 * py-1.5 / disabled:bg-neutral-50 能覆盖它。改成 variant 后，variant 类进入
 * utilities 层，覆盖关系改由 twMerge 决定。
 *
 * 这里覆盖代码库中实际出现的每一种附加 class 组合（共 5 类），
 * 逐一断言「被覆盖的属性只剩调用点那一个值」。
 *
 * 断言对象是 token 类名而不是字面值。原 `.settings-input` 的视觉值保留在
 * tokens/primitive.css 与 tokens/semantic.css 里，由
 * tests/ci/design-token-values.test.ts 守住数值，这里只守「filled 变体确实
 * 引用了那几个 token」。
 */
import Input from '@components/ui/input/Input.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const mountInput = (props: Record<string, unknown> = {}) =>
    mount(Input, {
        props,
        attachTo: document.body,
    });

const classList = (props: Record<string, unknown> = {}) => mountInput(props).classes();

describe('settings-input → Input variant="filled" 迁移等价性', () => {
    it('filled 携带 .settings-input 的全部属性', () => {
        const classes = classList({ variant: 'filled' });
        // 原 .settings-input 的 @apply 内容，逐条映射到 token
        expect(classes).toContain('focus:border-primary-300');
        expect(classes).toContain('rounded-control'); // 原 rounded-[10px]
        expect(classes).toContain('border-transparent');
        expect(classes).toContain('bg-surface-sunken'); // 原 bg-[#f0f0ef]
        expect(classes).toContain('px-3');
        expect(classes).toContain('py-2');
        expect(classes).toContain('text-compact'); // 原 text-[13px]
        expect(classes).toContain('text-neutral-900');
        expect(classes).toContain('shadow-none');
        expect(classes).toContain('hover:bg-surface-active'); // 原 hover:bg-[#ececea]
        expect(classes).toContain('focus:bg-white');
        expect(classes).toContain('focus:outline-none');
    });

    it('filled 不再携带 default 的白底灰边', () => {
        const classes = classList({ variant: 'filled' });
        expect(classes).not.toContain('bg-white');
        expect(classes).not.toContain('border-gray-200');
        expect(classes).not.toContain('text-sm');
        expect(classes).not.toContain('rounded-lg');
    });

    it('filled 不再包含任何任意值', () => {
        const classes = classList({ variant: 'filled' });

        for (const className of classes) {
            expect(className, `arbitrary value left in filled: ${className}`).not.toMatch(
                /-\[[^\]]+\]/
            );
        }
    });

    describe('调用点附加 class 的覆盖行为', () => {
        // 组合 1：搜索框 —— w-full py-1.5 pr-3 pl-9
        it('py-1.5 覆盖 filled 的 py-2', () => {
            const classes = classList({
                variant: 'filled',
                class: 'w-full py-1.5 pr-3 pl-9',
            });
            expect(classes).toContain('py-1.5');
            expect(classes).not.toContain('py-2');
            expect(classes).toContain('pl-9');
            expect(classes).toContain('pr-3');
        });

        // 组合 2：单行输入 —— mt-1.5 w-full
        it('mt-1.5 w-full 与 filled 无属性冲突', () => {
            const classes = classList({ variant: 'filled', class: 'mt-1.5 w-full' });
            expect(classes).toContain('mt-1.5');
            expect(classes).toContain('w-full');
            expect(classes).toContain('py-2');
        });

        // 组合 3：mono 多行字段 —— flex-1 px-4 py-2.5 font-mono
        it('px-4 py-2.5 同时覆盖 filled 的两轴内边距', () => {
            const classes = classList({
                variant: 'filled',
                class: 'flex-1 px-4 py-2.5 font-mono',
            });
            expect(classes).toContain('px-4');
            expect(classes).not.toContain('px-3');
            expect(classes).toContain('py-2.5');
            expect(classes).not.toContain('py-2');
            expect(classes).toContain('font-mono');
        });

        // 组合 4：只读字段 —— disabled:bg-neutral-50
        it('disabled:bg-neutral-50 不被 filled 的 disabled 背景覆盖', () => {
            const classes = classList({
                variant: 'filled',
                class: 'w-full disabled:bg-neutral-50',
            });
            // base 里有 disabled:bg-gray-50，调用点后写的 disabled:bg-neutral-50 应胜出
            expect(classes).toContain('disabled:bg-neutral-50');
            expect(classes).not.toContain('disabled:bg-gray-50');
        });

        // 组合 5：设置页搜索框 —— h-9 w-full pr-8 pl-8 text-xs
        it('text-xs 覆盖 filled 的 text-compact', () => {
            const classes = classList({
                variant: 'filled',
                class: 'h-9 w-full pr-8 pl-8 text-xs',
            });
            expect(classes).toContain('text-xs');
            expect(classes).not.toContain('text-compact');
        });
    });
});
