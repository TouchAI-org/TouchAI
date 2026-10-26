import SearchableSelect from '@components/SearchableSelect.vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';

/**
 * SearchableSelect is the picker behind the model and provider lists. These cover the parts a
 * user hits with real data: options without a description, a search box they clear, the arrow
 * keys moving back up, and the three placeholders that can be overridden.
 *
 * jsdom has no layout, so the list's scroll-into-view is a no-op here.
 */

const options = [
    { value: 1, label: 'GPT 5', description: '[OI]', searchText: 'gpt-5 openai' },
    { value: 2, label: 'the model', description: 'Anthropic', searchText: 'claude anthropic' },
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
    setLocale('en-US');
    Element.prototype.scrollIntoView = () => {};
    document.body.innerHTML = '';
});

describe('user sees the labels a caller configured', () => {
    it('user sees the placeholder given as a message key', () => {
        const wrapper = mountSelect({ placeholderKey: 'common.emptyOptions' });

        expect(wrapper.get('button').text()).toContain('No options');

        wrapper.unmount();
    });

    it('user sees the search box hint given as a message key', async () => {
        const wrapper = mountSelect({ searchPlaceholderKey: 'common.emptyOptions' });

        await openSelect(wrapper);

        expect(wrapper.get('input').attributes('placeholder')).toBe('No options');

        wrapper.unmount();
    });

    it('user sees the search box hint they typed instead of the default one', async () => {
        const wrapper = mountSelect({ searchPlaceholder: 'Find a model' });

        await openSelect(wrapper);

        expect(wrapper.get('input').attributes('placeholder')).toBe('Find a model');

        wrapper.unmount();
    });

    it('user sees the default search box hint when the caller gave none', async () => {
        const wrapper = mountSelect();

        await openSelect(wrapper);

        expect(wrapper.get('input').attributes('placeholder')).not.toBe('');

        wrapper.unmount();
    });

    it('user sees the empty-list message given as a message key', async () => {
        const wrapper = mountSelect({ options: [], emptyTextKey: 'common.emptyOptions' });

        await openSelect(wrapper);

        expect(wrapper.text()).toContain('No options');

        wrapper.unmount();
    });

    it('user sees the empty-list message they typed instead of the default one', async () => {
        const wrapper = mountSelect({ options: [], emptyText: 'No models configured' });

        await openSelect(wrapper);

        expect(wrapper.text()).toContain('No models configured');

        wrapper.unmount();
    });

    it('user sees the default empty-list message when the caller gave none', async () => {
        const wrapper = mountSelect({ options: [] });

        await openSelect(wrapper);

        expect(wrapper.text()).toContain('No options');

        wrapper.unmount();
    });
});

describe('user searches a list whose options have no extra text', () => {
    it('user still finds an option that has only a label', async () => {
        const wrapper = mountSelect({
            options: [{ value: 1, label: 'Plain name' }],
            modelValue: null,
        });

        await openSelect(wrapper);
        await wrapper.get('input').setValue('plain');

        expect(wrapper.text()).toContain('Plain name');

        wrapper.unmount();
    });

    it('user does not find an option whose label does not match the search', async () => {
        const wrapper = mountSelect({
            options: [{ value: 1, label: 'Plain name' }],
            modelValue: null,
        });

        await openSelect(wrapper);
        await wrapper.get('input').setValue('other');

        expect(wrapper.text()).not.toContain('Plain name');

        wrapper.unmount();
    });

    it('user sees the search cleared back to the full list when they empty the box', async () => {
        const wrapper = mountSelect();

        await openSelect(wrapper);
        await wrapper.get('input').setValue('deep');
        expect(wrapper.text()).not.toContain('GPT 5');

        await wrapper.get('input').setValue('');

        expect(wrapper.text()).toContain('GPT 5');
        expect(wrapper.text()).toContain('DeepSeek Chat');

        wrapper.unmount();
    });
});

describe('user moves the highlight through the list', () => {
    it('user moves the highlight back up with the up arrow', async () => {
        const wrapper = mountSelect({ modelValue: 3 });

        await openSelect(wrapper);
        await wrapper.get('input').trigger('keydown', { key: 'ArrowUp' });
        await wrapper.get('input').trigger('keydown', { key: 'Enter' });

        expect(wrapper.emitted('update:modelValue')).toEqual([[2]]);

        wrapper.unmount();
    });

    it('user stays on the first option when pressing up again', async () => {
        const wrapper = mountSelect({ modelValue: 1 });

        await openSelect(wrapper);
        for (let press = 0; press < 4; press += 1) {
            await wrapper.get('input').trigger('keydown', { key: 'ArrowUp' });
        }
        await wrapper.get('input').trigger('keydown', { key: 'Enter' });

        expect(wrapper.emitted('update:modelValue')).toEqual([[1]]);

        wrapper.unmount();
    });

    it('user does not pick anything with Enter when the search matched nothing', async () => {
        const wrapper = mountSelect();

        await openSelect(wrapper);
        await wrapper.get('input').setValue('zzz');
        await wrapper.get('input').trigger('keydown', { key: 'Enter' });

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();

        wrapper.unmount();
    });

    it('user does not move the highlight when the search matched nothing', async () => {
        const wrapper = mountSelect();

        await openSelect(wrapper);
        await wrapper.get('input').setValue('zzz');
        await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('input').trigger('keydown', { key: 'ArrowUp' });

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.text()).toContain('No options');

        wrapper.unmount();
    });

    it('user sees the highlight follow the pointer over an option', async () => {
        const wrapper = mountSelect({ modelValue: 1 });

        await openSelect(wrapper);
        const listButtons = wrapper.findAll('button').slice(1);
        await listButtons[2]!.trigger('mouseenter');
        await wrapper.get('input').trigger('keydown', { key: 'Enter' });

        expect(wrapper.emitted('update:modelValue')).toEqual([[3]]);

        wrapper.unmount();
    });

    it('user sees the highlight move into range when their search shortens the list', async () => {
        const wrapper = mountSelect({ modelValue: 3 });

        await openSelect(wrapper);
        // The chosen option is last, so the highlight starts at index 2; narrowing to one row
        // must pull the highlight back onto it.
        await wrapper.get('input').setValue('gpt');
        await wrapper.get('input').trigger('keydown', { key: 'Enter' });

        expect(wrapper.emitted('update:modelValue')).toEqual([[1]]);

        wrapper.unmount();
    });

    it('user sees the highlight reset when their search matches nothing at all', async () => {
        const wrapper = mountSelect({ modelValue: 3 });

        await openSelect(wrapper);
        await wrapper.get('input').setValue('zzz');
        await wrapper.get('input').setValue('deep');
        await wrapper.get('input').trigger('keydown', { key: 'Enter' });

        expect(wrapper.emitted('update:modelValue')).toEqual([[3]]);

        wrapper.unmount();
    });
});

describe('user opens and closes the list', () => {
    it('user closes the list by clicking the trigger again', async () => {
        const wrapper = mountSelect();

        await openSelect(wrapper);
        await wrapper.get('button').trigger('click');
        await flushPromises();

        expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');

        wrapper.unmount();
    });

    it('user opens the list with Enter on the trigger', async () => {
        const wrapper = mountSelect();

        await wrapper.get('button').trigger('keydown', { key: 'Enter' });
        await flushPromises();

        expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');

        wrapper.unmount();
    });

    it('user opens the list with the space bar on the trigger', async () => {
        const wrapper = mountSelect();

        await wrapper.get('button').trigger('keydown', { key: ' ' });
        await flushPromises();

        expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');

        wrapper.unmount();
    });

    it('user does not see an unrelated key open the list', async () => {
        const wrapper = mountSelect();

        await wrapper.get('button').trigger('keydown', { key: 'a' });
        await flushPromises();

        expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');

        wrapper.unmount();
    });

    it('user does not get a disabled control opened with the keyboard', async () => {
        const wrapper = mountSelect({ disabled: true });

        await wrapper.get('button').trigger('keydown', { key: 'ArrowDown' });
        await flushPromises();

        expect(wrapper.get('button').attributes('aria-expanded')).toBe('false');

        wrapper.unmount();
    });

    it('user keeps the list open when clicking inside it', async () => {
        const wrapper = mountSelect();

        await openSelect(wrapper);
        wrapper
            .get('input')
            .element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await flushPromises();

        expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');

        wrapper.unmount();
    });

    it('user gets the outside-click listener removed when the control is removed', async () => {
        const removeListener = vi.spyOn(document, 'removeEventListener');
        const wrapper = mountSelect();

        await openSelect(wrapper);
        wrapper.unmount();

        expect(removeListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));

        removeListener.mockRestore();
    });

    it('user sees the list close when their chosen value changes from outside', async () => {
        const wrapper = mountSelect({ modelValue: 1 });

        await openSelect(wrapper);
        await wrapper.get('input').setValue('deep');

        await wrapper.setProps({ modelValue: 2 });
        await flushPromises();

        // Choosing from outside the open list keeps the list open but the search must reset,
        // so the user is not left with a filtered list for a value they just changed.
        expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');

        wrapper.unmount();
    });
});

describe('user sees a list of brand names kept out of translation', () => {
    it('user gets no translation guard on ordinary option text', async () => {
        const wrapper = mountSelect({ modelValue: 1, protectOptionText: false });

        await openSelect(wrapper);

        expect(wrapper.find('[translate="no"]').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user sees the option description marked as protected along with its label', async () => {
        const wrapper = mountSelect({ modelValue: 1, protectOptionText: true });

        await openSelect(wrapper);

        const protectedNodes = wrapper.findAll('[translate="no"]');
        const texts = protectedNodes.map((node) => node.text());
        expect(texts).toContain('GPT 5');
        expect(texts).toContain('[OI]');

        wrapper.unmount();
    });

    it('user sees an option with no description rendered as a label only', async () => {
        const wrapper = mountSelect({
            options: [{ value: 1, label: 'Plain name' }],
            modelValue: 1,
        });

        await openSelect(wrapper);

        const listButtons = wrapper.findAll('button').slice(1);
        expect(listButtons[0]!.findAll('span')).toHaveLength(1);

        wrapper.unmount();
    });

    it('user sees the caller own option rendering instead of the default one', async () => {
        const custom = mount(SearchableSelect, {
            props: { modelValue: 1, options },
            slots: {
                option: `<template #option="{ option, highlighted, selected }">
                    <span data-testid="custom-option">{{ option.label }}|{{ highlighted }}|{{ selected }}</span>
                </template>`,
            },
            attachTo: document.body,
        });

        await custom.get('button').trigger('click');
        await flushPromises();

        expect(custom.get('[data-testid="custom-option"]').text()).toBe('GPT 5|true|true');

        custom.unmount();
    });

    it('user sees the caller own selected rendering on the trigger', () => {
        const custom = mount(SearchableSelect, {
            props: { modelValue: 2, options },
            slots: {
                selected: `<template #selected="{ option }">
                    <span data-testid="custom-selected">Chosen: {{ option?.label }}</span>
                </template>`,
            },
            attachTo: document.body,
        });

        expect(custom.get('[data-testid="custom-selected"]').text()).toBe('Chosen: the model');

        custom.unmount();
    });
});
