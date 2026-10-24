// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Button 的 class 稳定性快照测试。
 *
 * 目的：本仓库对 UI 原语的硬约束是「视觉零变化」。由于所有视觉都体现在 class 字符串上，
 * 锁定 class 就等于锁定视觉。任何后续改动（新增 variant、调整 base、升级 cva）导致
 * class 变化时，这个测试会立即失败，强制作者显式确认这是有意为之。
 *
 * 断言的是 class 字符串整体，不断言具体颜色值 —— 后者属于实现细节。
 */
import Button from '@components/ui/button/Button.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const mountButton = (props: Record<string, unknown> = {}) =>
    mount(Button, {
        props,
        slots: { default: 'label' },
        attachTo: document.body,
    });

describe('user sees a button', () => {
    describe('user sees the existing buttons unchanged', () => {
        it('user sees the default button unchanged', () => {
            expect(mountButton().classes().sort()).toMatchSnapshot();
        });

        it('user variant=outline 的 class 稳定', () => {
            expect(mountButton({ variant: 'outline' }).classes().sort()).toMatchSnapshot();
        });

        it('user variant=ghost size=icon 的 class 稳定', () => {
            expect(
                mountButton({ variant: 'ghost', size: 'icon' }).classes().sort()
            ).toMatchSnapshot();
        });
    });

    describe('user sees every button variant unchanged', () => {
        const variants = [
            'default',
            'destructive',
            'outline',
            'secondary',
            'ghost',
            'link',
        ] as const;

        it.each(variants)('user variant=%s', (variant) => {
            expect(mountButton({ variant }).classes().sort()).toMatchSnapshot();
        });

        const sizes = ['default', 'sm', 'lg', 'icon'] as const;

        it.each(sizes)('user size=%s', (size) => {
            expect(mountButton({ size }).classes().sort()).toMatchSnapshot();
        });
    });

    describe('user sees the settings buttons unchanged', () => {
        it('user variant=strong 等价于 settings-button-primary', () => {
            const classes = mountButton({ variant: 'strong' }).classes();
            expect(classes.sort()).toMatchSnapshot();
            // 原类：bg-primary-700 hover:bg-primary-600 rounded-action px-3.5 py-1.5
            // text-dense font-medium text-white shadow-none transition-colors
            // disabled:cursor-not-allowed disabled:opacity-50
            //
            // text-dense (12px) rather than text-xs: text-xs also sets a 16px
            // line-height, while the original text-[12px] inherited one. Using
            // text-xs made every settings button 16px tall.
            for (const expected of [
                'bg-primary-700',
                'hover:bg-primary-600',
                'rounded-action',
                'px-3.5',
                'py-1.5',
                'text-dense',
                'font-medium',
                'text-white',
                'shadow-none',
                'transition-colors',
                'disabled:cursor-not-allowed',
                'disabled:opacity-50',
            ]) {
                expect(classes).toContain(expected);
            }
            // settings 族不得携带 default 族的布局类
            expect(classes).not.toContain('inline-flex');
            expect(classes).not.toContain('disabled:pointer-events-none');
            expect(classes).not.toContain('rounded-md');
            expect(classes).not.toContain('text-sm');
        });

        it('user variant=outline-neutral 等价于 settings-button-secondary', () => {
            const classes = mountButton({ variant: 'outline-neutral' }).classes();
            expect(classes.sort()).toMatchSnapshot();
            expect(classes).toContain('border-neutral-200/80');
            expect(classes).toContain('text-neutral-700');
            expect(classes).toContain('hover:bg-neutral-50');
            expect(classes).not.toContain('inline-flex');
        });

        it('user variant=danger 等价于 settings-button-danger', () => {
            const classes = mountButton({ variant: 'danger' }).classes();
            expect(classes.sort()).toMatchSnapshot();
            expect(classes).toContain('bg-red-600');
            expect(classes).toContain('hover:bg-red-700');
            expect(classes).not.toContain('inline-flex');
        });

        it('user variant=ghost-neutral 等价于 settings-icon-button', () => {
            const classes = mountButton({ variant: 'ghost-neutral' }).classes();
            expect(classes.sort()).toMatchSnapshot();
            // 原类：flex h-8 w-8 items-center justify-center rounded-action
            // text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700
            for (const expected of [
                'flex',
                'h-8',
                'w-8',
                'items-center',
                'justify-center',
                'rounded-action',
                'text-neutral-400',
                'transition-colors',
                'hover:bg-neutral-100',
                'hover:text-neutral-700',
            ]) {
                expect(classes).toContain(expected);
            }
            // icon 族不得携带 settings 族的内边距与字号
            expect(classes).not.toContain('px-3.5');
            expect(classes).not.toContain('py-1.5');
            expect(classes).not.toContain('text-dense');
            expect(classes).not.toContain('font-medium');
        });

        it('user settings / icon 族忽略 size 轴（尺寸已含在 layout 内）', () => {
            for (const variant of [
                'strong',
                'outline-neutral',
                'danger',
                'ghost-neutral',
            ] as const) {
                const withDefault = mountButton({ variant, size: 'default' }).classes();
                const withLarge = mountButton({ variant, size: 'lg' }).classes();
                expect(withDefault.sort()).toEqual(withLarge.sort());
                expect(withLarge).not.toContain('h-10');
                expect(withLarge).not.toContain('px-8');
            }
        });
    });

    describe('user sees the icon button sizes', () => {
        it('user size=icon-sm 输出 h-7 w-7', () => {
            const classes = mountButton({ size: 'icon-sm' }).classes();
            expect(classes).toContain('h-7');
            expect(classes).toContain('w-7');
        });

        it('user size=icon-md 输出 h-8 w-8', () => {
            const classes = mountButton({ size: 'icon-md' }).classes();
            expect(classes).toContain('h-8');
            expect(classes).toContain('w-8');
        });
    });

    describe('user sees the button keep its call-site class', () => {
        it('user gets the call-site class alongside the variant classes', () => {
            const wrapper = mountButton({ class: 'custom-x' });
            expect(wrapper.classes()).toContain('custom-x');
            expect(wrapper.classes()).toContain('inline-flex');
        });

        it('user gets the call-site height instead of the variant height', () => {
            const classes = mountButton({
                variant: 'strong',
                class: 'inline-flex h-9 items-center justify-center px-4',
            }).classes();

            expect(classes).toContain('h-9');
            expect(classes).not.toContain('h-10');
        });

        it('user gets the call-site padding instead of the variant padding', () => {
            const classes = mountButton({ variant: 'strong', class: 'px-3 py-1.5' }).classes();

            expect(classes).toContain('px-3');
            expect(classes).not.toContain('px-3.5');
            expect(classes).toContain('py-1.5');
        });

        it('user keeps a full-width call-site class', () => {
            const classes = mountButton({
                variant: 'strong',
                class: 'flex w-full items-center justify-center gap-2 break-words whitespace-normal',
            }).classes();

            expect(classes).toContain('w-full');
            expect(classes).toContain('break-words');
            expect(classes).toContain('whitespace-normal');
        });
    });
});
