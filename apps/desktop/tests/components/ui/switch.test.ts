// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Switch 的行为与 class 快照测试。
 *
 * 三种 size 对应代码库中三种尺寸不同的手写 toggle，thumb 分别为 12px / 16px /
 * 14px，位移量也各不相同，像素级不等价，必须分别锁定，避免将来「统一」时
 * 引入视觉变化。
 *
 * 注意：SwitchRoot 渲染为 <button role="switch">，组件根元素即该 button，
 * 但 @vue/test-utils 的 wrapper.classes() 在组件根为第三方组件时不可靠，
 * 因此统一用 wrapper.get('button') / wrapper.get('span') 定位。
 */
import Switch from '@components/ui/switch/Switch.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const mountSwitch = (props: Record<string, unknown> = {}) =>
    mount(Switch, {
        props,
        attachTo: document.body,
    });

const rootOf = (wrapper: ReturnType<typeof mountSwitch>) => wrapper.get('button');
const thumbOf = (wrapper: ReturnType<typeof mountSwitch>) => wrapper.get('span');

describe('ui/Switch', () => {
    describe('class 稳定性', () => {
        it('size=sm 关闭态', () => {
            expect(
                rootOf(mountSwitch({ modelValue: false }))
                    .classes()
                    .sort()
            ).toMatchSnapshot();
        });

        it('size=sm 开启态', () => {
            expect(
                rootOf(mountSwitch({ modelValue: true }))
                    .classes()
                    .sort()
            ).toMatchSnapshot();
        });

        it('size=md 关闭态', () => {
            expect(
                rootOf(mountSwitch({ modelValue: false, size: 'md' }))
                    .classes()
                    .sort()
            ).toMatchSnapshot();
        });

        it('size=md 开启态', () => {
            expect(
                rootOf(mountSwitch({ modelValue: true, size: 'md' }))
                    .classes()
                    .sort()
            ).toMatchSnapshot();
        });

        it('size=lg 开启态', () => {
            expect(
                rootOf(mountSwitch({ modelValue: true, size: 'lg' }))
                    .classes()
                    .sort()
            ).toMatchSnapshot();
        });

        it('tone=subtle 使用 primary-500 / gray-200', () => {
            const classes = rootOf(mountSwitch({ modelValue: true, tone: 'subtle' })).classes();
            expect(classes).toContain('data-[state=checked]:bg-primary-500');
            expect(classes).toContain('data-[state=unchecked]:bg-gray-200');
            expect(classes).not.toContain('data-[state=checked]:bg-primary-700');
        });

        it('tone=default 使用 primary-700 / neutral-200', () => {
            const classes = rootOf(mountSwitch({ modelValue: true })).classes();
            expect(classes).toContain('data-[state=checked]:bg-primary-700');
            expect(classes).toContain('data-[state=unchecked]:bg-neutral-200');
        });
    });

    describe('三种尺寸差异必须保留', () => {
        it('sm 的 thumb 是 h-3 w-3 且流式定位', () => {
            const classes = thumbOf(mountSwitch({ size: 'sm' })).classes();
            expect(classes).toContain('h-3');
            expect(classes).toContain('w-3');
            expect(classes).toContain('inline-block');
            expect(classes).not.toContain('absolute');
        });

        it('md 的 thumb 是 h-4 w-4 且绝对定位', () => {
            const classes = thumbOf(mountSwitch({ size: 'md' })).classes();
            expect(classes).toContain('h-4');
            expect(classes).toContain('w-4');
            expect(classes).toContain('absolute');
            expect(classes).toContain('top-0.5');
            expect(classes).toContain('left-0.5');
        });

        it('lg 的 thumb 是 h-3.5 w-3.5 且流式定位', () => {
            const classes = thumbOf(mountSwitch({ size: 'lg' })).classes();
            expect(classes).toContain('h-3.5');
            expect(classes).toContain('w-3.5');
            expect(classes).toContain('inline-block');
            expect(classes).not.toContain('absolute');
        });

        it('三种 size 的位移量各不相同', () => {
            expect(thumbOf(mountSwitch({ size: 'sm' })).classes()).toContain(
                'data-[state=checked]:translate-x-5'
            );
            expect(thumbOf(mountSwitch({ size: 'md' })).classes()).toContain(
                'data-[state=checked]:translate-x-4'
            );
            expect(thumbOf(mountSwitch({ size: 'lg' })).classes()).toContain(
                'data-[state=checked]:translate-x-[18px]'
            );
        });
    });

    describe('行为', () => {
        it('点击时发出 update:modelValue', async () => {
            const wrapper = mountSwitch({ modelValue: false });
            await rootOf(wrapper).trigger('click');
            expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([true]);
        });

        it('disabled 时不发事件', async () => {
            const wrapper = mountSwitch({ modelValue: false, disabled: true });
            await rootOf(wrapper).trigger('click');
            expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        });

        it('提供正确的 switch 语义', () => {
            const root = rootOf(mountSwitch({ modelValue: true }));
            expect(root.attributes('role')).toBe('switch');
            expect(root.attributes('aria-checked')).toBe('true');
        });

        it('disabled 时附加 cursor-not-allowed 与 opacity-50', () => {
            const classes = rootOf(mountSwitch({ disabled: true })).classes();
            expect(classes).toContain('cursor-not-allowed');
            expect(classes).toContain('opacity-50');
        });
    });
});
