// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * 迁移等价性验证：`.settings-button-*` 自研类 → Button variant。
 *
 * 这个测试存在的理由：`.settings-button-*` 定义在 @layer components，优先级低于
 * utilities 层，因此调用点附加的 px-3 py-1.5 / h-9 / w-full 能覆盖它。
 * 改成 variant 后，variant 类进入 utilities 层，覆盖关系改由 twMerge 决定。
 *
 * 两条路径的「最终生效值」必须一致。这里用真实浏览器环境（jsdom + Tailwind
 * 编译产物）验证计算后样式，而不是只比对 class 字符串。
 */
import Button from '@components/ui/button/Button.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const mountButton = (props: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) =>
    mount(Button, {
        props,
        attrs,
        slots: { default: 'label' },
        attachTo: document.body,
    });

/**
 * 从元素的 class 列表中提取某个 CSS 属性的候选值。
 * 不做真实 CSS 计算（jsdom 不跑 Tailwind），只验证 twMerge 之后
 * 每个属性只剩一个候选类，且该候选类与迁移前一致。
 */
const classList = (wrapper: ReturnType<typeof mountButton>) => wrapper.classes();

describe('settings-button-* → Button variant 迁移等价性', () => {
    it('settings-button-primary 的等效 variant 是 strong', () => {
        const classes = classList(mountButton({ variant: 'strong' }));
        // 原类在 @layer components 中定义的属性
        expect(classes).toContain('bg-primary-700');
        expect(classes).toContain('hover:bg-primary-600');
        expect(classes).toContain('rounded-action');
        expect(classes).toContain('px-3.5');
        expect(classes).toContain('py-1.5');
        expect(classes).toContain('text-xs');
        expect(classes).toContain('font-medium');
        expect(classes).toContain('text-white');
        expect(classes).toContain('shadow-none');
        expect(classes).toContain('transition-colors');
        expect(classes).toContain('disabled:cursor-not-allowed');
        expect(classes).toContain('disabled:opacity-50');
    });

    it('settings-button-secondary 的等效 variant 是 outline-neutral', () => {
        const classes = classList(mountButton({ variant: 'outline-neutral' }));
        expect(classes).toContain('rounded-action');
        expect(classes).toContain('border');
        expect(classes).toContain('border-neutral-200/80');
        expect(classes).toContain('bg-white');
        expect(classes).toContain('text-neutral-700');
        expect(classes).toContain('hover:border-neutral-300/80');
        expect(classes).toContain('hover:bg-neutral-50');
    });

    it('settings-button-danger 的等效 variant 是 danger', () => {
        const classes = classList(mountButton({ variant: 'danger' }));
        expect(classes).toContain('bg-red-600');
        expect(classes).toContain('hover:bg-red-700');
        expect(classes).toContain('rounded-action');
        expect(classes).toContain('text-white');
    });

    it('settings-icon-button 的等效 variant 是 ghost-neutral', () => {
        const classes = classList(mountButton({ variant: 'ghost-neutral' }));
        expect(classes).toContain('flex');
        expect(classes).toContain('h-8');
        expect(classes).toContain('w-8');
        expect(classes).toContain('items-center');
        expect(classes).toContain('justify-center');
        expect(classes).toContain('rounded-action');
        expect(classes).toContain('text-neutral-400');
        expect(classes).toContain('hover:bg-neutral-100');
        expect(classes).toContain('hover:text-neutral-700');
    });

    describe('调用点附加 class 的覆盖行为', () => {
        it('h-9 能覆盖 icon 族的高度，与迁移前一致', () => {
            // 迁移前：.settings-button-primary 不含 h-*，h-9 直接生效
            // 迁移后：layout=settings 不含 h-*，h-9 依然生效
            const classes = classList(
                mountButton({
                    variant: 'strong',
                    class: 'inline-flex h-9 items-center justify-center px-4',
                })
            );
            expect(classes).toContain('h-9');
            expect(classes).not.toContain('h-10');
        });

        it('px-3 py-1.5 覆盖 variant 的 px-3.5 py-1.5（twMerge 去重）', () => {
            const classes = classList(
                mountButton({ variant: 'strong', class: 'flex-shrink-0 px-3 py-1.5' })
            );
            // twMerge 应只保留后写的 px-3 / py-1.5
            expect(classes).toContain('px-3');
            expect(classes).not.toContain('px-3.5');
            expect(classes).toContain('py-1.5');
        });

        it('w-full 与 variant 无冲突，正常生效', () => {
            const classes = classList(mountButton({ variant: 'strong', class: 'w-full' }));
            expect(classes).toContain('w-full');
        });

        it('break-words whitespace-normal 与 variant 无冲突', () => {
            const classes = classList(
                mountButton({
                    variant: 'strong',
                    class: 'flex w-full items-center justify-center gap-2 break-words whitespace-normal',
                })
            );
            expect(classes).toContain('break-words');
            expect(classes).toContain('whitespace-normal');
        });
    });
});
