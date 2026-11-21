// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import Textarea from '@components/ui/textarea/Textarea.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

describe('user edits plain text in a textarea', () => {
    it('user sees the default textarea keep its design-system classes', () => {
        const wrapper = mount(Textarea);

        expect(wrapper.classes().sort()).toMatchSnapshot();
    });

    it('user types text and receives a value update', async () => {
        const wrapper = mount(Textarea, {
            props: {
                modelValue: '',
            },
        });

        await wrapper.get('textarea').setValue('Review this change.');

        expect(wrapper.emitted('update:modelValue')).toEqual([['Review this change.']]);
    });

    it('user sees an empty field when the bound value is null', () => {
        const wrapper = mount(Textarea, {
            props: {
                modelValue: null,
            },
        });

        expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    });

    it('user gets input and accessibility attributes on the real field', () => {
        const wrapper = mount(Textarea, {
            attrs: {
                'aria-label': 'Prompt',
                'data-testid': 'prompt-body',
                spellcheck: 'false',
            },
        });

        const field = wrapper.get('textarea');
        expect(field.attributes('aria-label')).toBe('Prompt');
        expect(field.attributes('data-testid')).toBe('prompt-body');
        expect(field.attributes('spellcheck')).toBe('false');
    });

    it('user sees a disabled field that cannot accept edits', () => {
        const wrapper = mount(Textarea, {
            props: {
                modelValue: 'Fixed',
                disabled: true,
            },
        });

        expect(wrapper.get('textarea').attributes('disabled')).toBeDefined();
    });
});
