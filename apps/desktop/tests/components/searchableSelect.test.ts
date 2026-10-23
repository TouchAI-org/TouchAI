// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import SearchableSelect from '@components/SearchableSelect.vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';

const options = [
    { value: 1, label: 'GPT 5', description: 'OpenAI', searchText: 'gpt-5 openai' },
    { value: 2, label: 'Claude Sonnet', description: 'Anthropic', searchText: 'claude anthropic' },
    { value: 3, label: 'DeepSeek Chat', description: 'DeepSeek', searchText: 'deepseek' },
];

function mountSelect(props: Record<string, unknown> = {}) {
    return mount(SearchableSelect, {
        props: { modelValue: null, options, ...props },
        attachTo: document.body,
    });
}

async function openSelect(wrapper: ReturnType<typeof mountSelect>) {
    await wrapper.get('button').trigger('click');
    await flushPromises();
}

beforeEach(() => {
    setLocale('zh-CN');
    // jsdom has no layout, so the list's scroll-into-view is a no-op.
    Element.prototype.scrollIntoView = () => {};
});

describe('user picks an option from a searchable list', () => {
    it('user sees the chosen option on the trigger', () => {
        const wrapper = mountSelect({ modelValue: 2 });

        expect(wrapper.get('button').text()).toContain('Claude Sonnet');
    });

    it('user sees a placeholder while nothing is chosen', () => {
        const wrapper = mountSelect({ placeholder: 'Pick a model' });

        expect(wrapper.get('button').text()).toContain('Pick a model');
    });

    it('user sees the list opened with every option, marked as expanded', async () => {
        const wrapper = mountSelect();

        await openSelect(wrapper);

        expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');
        expect(wrapper.text()).toContain('GPT 5');
        expect(wrapper.text()).toContain('Claude Sonnet');
        expect(wrapper.text()).toContain('DeepSeek Chat');
    });

    it('user picks an option by clicking it and the list closes', async () => {
        const wrapper = mountSelect();

        await openSelect(wrapper);
        await wrapper
            .findAll('button')
            .find((button) => button.text().includes('Claude Sonnet'))!
            .trigger('mousedown');
        await flushPromises();

        expect(wrapper.emitted('update:modelValue')).toEqual([[2]]);
        expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');
    });

    it('user narrows the list by typing part of a name', async () => {
        const wrapper = mountSelect();
        await openSelect(wrapper);

        await wrapper.get('input').setValue('deep');

        expect(wrapper.text()).toContain('DeepSeek Chat');
        expect(wrapper.text()).not.toContain('GPT 5');
    });

    it('user finds an option by typing fragments of its name', async () => {
        const wrapper = mountSelect();
        await openSelect(wrapper);

        await wrapper.get('input').setValue('clsn');

        expect(wrapper.text()).toContain('Claude Sonnet');
    });

    it('user sees every word of a multi-word search applied together', async () => {
        const wrapper = mountSelect();
        await openSelect(wrapper);

        await wrapper.get('input').setValue('gpt openai');

        expect(wrapper.text()).toContain('GPT 5');
        expect(wrapper.text()).not.toContain('DeepSeek Chat');
    });

    it('user is told when nothing matches the search', async () => {
        const wrapper = mountSelect();
        await openSelect(wrapper);

        await wrapper.get('input').setValue('zzz');

        expect(wrapper.text()).toContain('暂无可选项');
    });

    it('user picks a highlighted option with the keyboard', async () => {
        const wrapper = mountSelect({ modelValue: 1 });
        await openSelect(wrapper);

        await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('input').trigger('keydown', { key: 'Enter' });

        expect(wrapper.emitted('update:modelValue')).toEqual([[2]]);
    });

    it('user does not run past the last option while arrowing down', async () => {
        const wrapper = mountSelect({ modelValue: 1 });
        await openSelect(wrapper);

        for (let index = 0; index < 6; index += 1) {
            await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' });
        }
        await wrapper.get('input').trigger('keydown', { key: 'Enter' });

        expect(wrapper.emitted('update:modelValue')).toEqual([[3]]);
    });

    it('user closes the list with Escape without choosing anything', async () => {
        const wrapper = mountSelect();

        await openSelect(wrapper);
        await wrapper.get('input').trigger('keydown', { key: 'Escape' });
        await flushPromises();

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');
    });

    it('user opens the list with the keyboard from the trigger', async () => {
        const wrapper = mountSelect();

        await wrapper.get('button').trigger('keydown', { key: 'ArrowDown' });
        await flushPromises();

        expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');
    });

    it('user closes the list by clicking outside it', async () => {
        const wrapper = mountSelect();
        await openSelect(wrapper);

        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await flushPromises();

        expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');
    });

    it('user sees a disabled control that cannot be opened', async () => {
        const wrapper = mountSelect({ disabled: true });

        await wrapper.get('button').trigger('click');
        await flushPromises();

        expect(wrapper.get('button').attributes('disabled')).toBeDefined();
        expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');
        expect(wrapper.find('input').exists()).toBe(false);
    });

    it('user sees the protected option text kept out of translation', async () => {
        const wrapper = mountSelect({ modelValue: 1, protectOptionText: true });

        expect(wrapper.get('button [translate="no"]').text()).toBe('GPT 5');
    });

    it('user sees the list closed and the search cleared after choosing', async () => {
        const wrapper = mountSelect();
        await openSelect(wrapper);
        await wrapper.get('input').setValue('claude');
        await wrapper
            .findAll('button')
            .find((button) => button.text().includes('Claude Sonnet'))!
            .trigger('mousedown');
        await flushPromises();

        await openSelect(wrapper);

        expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
        expect(wrapper.text()).toContain('GPT 5');
    });

    it('user sees the English placeholders when the app is in English', () => {
        setLocale('en-US');

        const wrapper = mountSelect();

        expect(wrapper.get('button').text()).toContain('Select');
    });
});
