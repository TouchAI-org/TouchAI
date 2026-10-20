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

describe('ui/Button', () => {
    describe('现有调用点的默认输出必须保持不变', () => {
        it('无 props 时的 class 稳定', () => {
            expect(mountButton().classes().sort()).toMatchSnapshot();
        });

        it('variant=outline 的 class 稳定', () => {
            expect(mountButton({ variant: 'outline' }).classes().sort()).toMatchSnapshot();
        });

        it('variant=ghost size=icon 的 class 稳定', () => {
            expect(
                mountButton({ variant: 'ghost', size: 'icon' }).classes().sort()
            ).toMatchSnapshot();
        });
    });

    describe('全部 variant 组合的 class 快照', () => {
        const variants = [
            'default',
            'destructive',
            'outline',
            'secondary',
            'ghost',
            'link',
        ] as const;

        it.each(variants)('variant=%s', (variant) => {
            expect(mountButton({ variant }).classes().sort()).toMatchSnapshot();
        });

        const sizes = ['default', 'sm', 'lg', 'icon'] as const;

        it.each(sizes)('size=%s', (size) => {
            expect(mountButton({ size }).classes().sort()).toMatchSnapshot();
        });
    });

    describe('调用点传入的 class 会被合并而非覆盖', () => {
        it('额外 class 追加在末尾', () => {
            const wrapper = mountButton({ class: 'custom-x' });
            expect(wrapper.classes()).toContain('custom-x');
            expect(wrapper.classes()).toContain('inline-flex');
        });
    });
});
