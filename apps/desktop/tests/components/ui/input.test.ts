// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Input 的 class 稳定性快照测试 + attrs 透传行为测试。
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

describe('ui/Input', () => {
    describe('class 稳定性', () => {
        it('无 props 时的 class 稳定', () => {
            expect(mountInput().classes().sort()).toMatchSnapshot();
        });

        it('调用点额外 class 会合并', () => {
            const wrapper = mountInput({ class: 'mt-1.5' });
            expect(wrapper.classes()).toContain('mt-1.5');
            expect(wrapper.classes()).toContain('w-full');
        });
    });

    describe('attrs 透传到原生 input', () => {
        it('maxlength 到达原生元素', () => {
            const wrapper = mountInput({ maxlength: 32 });
            expect(wrapper.get('input').attributes('maxlength')).toBe('32');
        });

        it('aria-* 到达原生元素', () => {
            const wrapper = mountInput({ 'aria-label': '搜索' });
            expect(wrapper.get('input').attributes('aria-label')).toBe('搜索');
        });

        it('data-* 到达原生元素', () => {
            const wrapper = mountInput({ 'data-testid': 'x' });
            expect(wrapper.get('input').attributes('data-testid')).toBe('x');
        });

        it('spellcheck 到达原生元素', () => {
            const wrapper = mountInput({ spellcheck: 'false' });
            expect(wrapper.get('input').attributes('spellcheck')).toBe('false');
        });

        it('根节点即原生 input，attrs 只存在一份', () => {
            const wrapper = mountInput({ maxlength: 8 });
            // 组件根节点就是 <input>，所以 wrapper 与 wrapper.get('input') 是同一个元素
            expect(wrapper.element).toBe(wrapper.get('input').element);
            expect(wrapper.attributes('maxlength')).toBe('8');
        });
    });

    describe('v-model 行为', () => {
        it('输入时发出 update:modelValue', async () => {
            const wrapper = mountInput({ modelValue: '' });
            await wrapper.get('input').setValue('hello');
            expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['hello']);
        });

        it('modelValue 为 null 时渲染空字符串', () => {
            const wrapper = mountInput({ modelValue: null });
            expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
        });
    });
});
