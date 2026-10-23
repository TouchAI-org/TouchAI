// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Input 的 class 稳定性快照 + attrs 透传行为测试。
 *
 * class 快照锁定的理由同 button.test.ts。
 * attrs 透传是 P0 修复的 bug：此前 Input 未设 inheritAttrs: false 也未转发 $attrs，
 * 导致 maxlength / aria-* / data-* 等属性丢失。
 */
import Input from '@components/ui/input/Input.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const mountInput = (props: Record<string, unknown> = {}) =>
    mount(Input, {
        props,
        attachTo: document.body,
    });

describe('user sees an input', () => {
    describe('user sees the row keep its look', () => {
        it('user sees the same default classes as before', () => {
            expect(mountInput().classes().sort()).toMatchSnapshot();
        });

        it('user gets the call-site class merged in', () => {
            const wrapper = mountInput({ class: 'mt-1.5' });
            expect(wrapper.classes()).toContain('mt-1.5');
            expect(wrapper.classes()).toContain('w-full');
        });
    });

    describe('user sees the input attributes reach the real field', () => {
        it('user gets the maxlength enforced on the real field', () => {
            const wrapper = mountInput({ maxlength: 32 });
            expect(wrapper.get('input').attributes('maxlength')).toBe('32');
        });

        it('user hears the field description from aria attributes', () => {
            const wrapper = mountInput({ 'aria-label': '搜索' });
            expect(wrapper.get('input').attributes('aria-label')).toBe('搜索');
        });

        it('user keeps test and automation hooks on the real field', () => {
            const wrapper = mountInput({ 'data-testid': 'x' });
            expect(wrapper.get('input').attributes('data-testid')).toBe('x');
        });

        it('user gets spellcheck forwarded to the real field', () => {
            const wrapper = mountInput({ spellcheck: 'false' });
            expect(wrapper.get('input').attributes('spellcheck')).toBe('false');
        });

        it('user sees a single field with the attributes applied once', () => {
            const wrapper = mountInput({ maxlength: 8 });
            // 组件根节点就是 <input>，所以 wrapper 与 wrapper.get('input') 是同一个元素
            expect(wrapper.element).toBe(wrapper.get('input').element);
            expect(wrapper.attributes('maxlength')).toBe('8');
        });
    });

    describe('user types into the input', () => {
        it('user typing reaches the parent as a value update', async () => {
            const wrapper = mountInput({ modelValue: '' });
            await wrapper.get('input').setValue('hello');
            expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['hello']);
        });

        it('user sees an empty field when the bound value is null', () => {
            const wrapper = mountInput({ modelValue: null });
            expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
        });
    });

    describe('user sees the input keep its call-site style', () => {
        it('user gets the call-site padding instead of the filled padding', () => {
            const classes = mountInput({
                variant: 'filled',
                class: 'w-full py-1.5 pr-3 pl-9',
            }).classes();

            expect(classes).toContain('py-1.5');
            expect(classes).not.toContain('py-2');
            expect(classes).toContain('pl-9');
            expect(classes).toContain('pr-3');
        });

        it('user gets the call-site font size instead of the variant font size', () => {
            const classes = mountInput({
                variant: 'filled',
                class: 'h-9 w-full pr-8 pl-8 text-[12px]',
            }).classes();

            expect(classes).toContain('text-[12px]');
            expect(classes).not.toContain('text-[13px]');
        });

        it('user gets the call-site disabled background on a read-only field', () => {
            const classes = mountInput({
                variant: 'filled',
                class: 'w-full disabled:bg-neutral-50',
            }).classes();

            expect(classes).toContain('disabled:bg-neutral-50');
            expect(classes).not.toContain('disabled:bg-gray-50');
        });
    });
});
