import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import CustomSelect from '@/components/CustomSelect.vue';
import { setLocale } from '@/i18n';

/**
 * CustomSelect is the one dropdown the settings pages use, so what the trigger shows and what the
 * form receives when an option is picked is the contract.
 *
 * The list is a reka-ui Select: it opens from the trigger's keyboard handler and commits a pick
 * from the option's pointer-up. Those are the real gestures a user makes; jsdom just needs them
 * dispatched explicitly instead of synthesised by a browser.
 */

const options = [
    { label: '[OI]', value: 'openai', description: 'GPT models' },
    { label: 'Anthropic', value: 'anthropic' },
    { label: 'DeepSeek', value: 'deepseek', iconSrc: '/logos/deepseek.png' },
];

function mountSelect(props: Record<string, unknown> = {}) {
    return mount(CustomSelect, {
        props: {
            modelValue: 'openai',
            options,
            disablePortal: true,
            ...props,
        },
        attachTo: document.body,
    });
}

function triggerOf(wrapper: ReturnType<typeof mountSelect>) {
    return wrapper.get('[role="combobox"]');
}

function listOptions(wrapper: ReturnType<typeof mountSelect>) {
    return wrapper.findAll('[role="option"]');
}

/** Opens the list the way the user does: focusing the trigger and pressing Enter. */
async function openList(wrapper: ReturnType<typeof mountSelect>): Promise<void> {
    triggerOf(wrapper).element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    await flushPromises();
}

/** Picks an option the way the user does: a pointer press released over the row. */
async function pick(wrapper: ReturnType<typeof mountSelect>, index: number): Promise<void> {
    listOptions(wrapper)[index]!.element.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true })
    );
    await flushPromises();
}

describe('user picks an option from a custom dropdown', () => {
    beforeEach(() => {
        setLocale('en-US');
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the current selection on the closed trigger', () => {
        const wrapper = mountSelect();

        expect(triggerOf(wrapper).text()).toContain('[OI]');

        wrapper.unmount();
    });

    it('user gets the chosen value handed back to the form', async () => {
        const wrapper = mountSelect();

        await openList(wrapper);
        await pick(wrapper, 1);

        expect(wrapper.emitted('update:modelValue')).toEqual([['anthropic']]);

        wrapper.unmount();
    });

    it('user sees the newly chosen value on the trigger once the form stores it', async () => {
        const wrapper = mountSelect();

        await openList(wrapper);
        await pick(wrapper, 1);
        await wrapper.setProps({ modelValue: 'anthropic' });

        expect(triggerOf(wrapper).text()).toContain('Anthropic');

        wrapper.unmount();
    });

    it('user sees the list open from the keyboard and the open state reported', async () => {
        const wrapper = mountSelect();

        await openList(wrapper);

        expect(wrapper.emitted('update:open')).toEqual([[true]]);
        expect(listOptions(wrapper)).toHaveLength(options.length);

        wrapper.unmount();
    });

    it('user sees the list stay closed when the parent keeps it closed', async () => {
        const wrapper = mountSelect({ open: false });

        await openList(wrapper);

        // The parent owns the open state while `open` is passed, so the list must not open itself.
        expect(listOptions(wrapper)).toHaveLength(0);

        wrapper.unmount();
    });

    it('user sees the list open when the parent controls it and opens it', async () => {
        const wrapper = mountSelect({ open: false });

        await wrapper.setProps({ open: true });
        await flushPromises();

        expect(listOptions(wrapper)).toHaveLength(options.length);

        wrapper.unmount();
    });

    it('user sees every option label and description in the list', async () => {
        const wrapper = mountSelect();

        await openList(wrapper);

        const listText = listOptions(wrapper)
            .map((option) => option.text())
            .join('|');
        expect(listText).toContain('[OI]');
        expect(listText).toContain('GPT models');
        expect(listText).toContain('Anthropic');
        expect(listText).toContain('DeepSeek');

        wrapper.unmount();
    });

    it('user sees the option logo next to its name', async () => {
        const wrapper = mountSelect();

        await openList(wrapper);

        const logo = listOptions(wrapper)[2]!.get('img');
        expect(logo.attributes('src')).toBe('/logos/deepseek.png');
        expect(logo.attributes('alt')).toBe('DeepSeek');

        wrapper.unmount();
    });

    it('user sees the current option highlighted so they know what is already picked', async () => {
        const wrapper = mountSelect();

        await openList(wrapper);

        expect(listOptions(wrapper)[0]!.classes()).toContain('bg-primary-50');
        expect(listOptions(wrapper)[1]!.classes()).toContain('text-gray-900');

        wrapper.unmount();
    });

    it('user sees the empty message when there is nothing to pick', async () => {
        const wrapper = mountSelect({ options: [], modelValue: '' });

        await openList(wrapper);

        expect(wrapper.text()).toContain('No options');
        expect(listOptions(wrapper)).toHaveLength(0);

        wrapper.unmount();
    });

    it('user gets a numeric option handed back as a number', async () => {
        const wrapper = mountSelect({
            modelValue: 1,
            options: [
                { label: 'One', value: 1 },
                { label: 'Two', value: 2 },
            ],
        });

        await openList(wrapper);
        await pick(wrapper, 1);

        expect(wrapper.emitted('update:modelValue')).toEqual([[2]]);

        wrapper.unmount();
    });

    it('user sees the list close again when they choose an option', async () => {
        const wrapper = mountSelect();

        await openList(wrapper);
        await pick(wrapper, 1);

        expect(wrapper.emitted('update:open')).toEqual([[true], [false]]);

        wrapper.unmount();
    });
});

describe('user sees what a dropdown will show before opening it', () => {
    beforeEach(() => {
        setLocale('en-US');
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the caller display label instead of the option label', () => {
        const wrapper = mountSelect({ displayLabel: 'Custom trigger text' });

        expect(triggerOf(wrapper).text()).toContain('Custom trigger text');
        expect(triggerOf(wrapper).text()).not.toContain('[OI]');

        wrapper.unmount();
    });

    it('user sees the selected option logo on the closed trigger', () => {
        const wrapper = mountSelect({ modelValue: 'deepseek' });

        const logo = triggerOf(wrapper).get('img');
        expect(logo.attributes('src')).toBe('/logos/deepseek.png');
        expect(logo.attributes('alt')).toBe('DeepSeek');

        wrapper.unmount();
    });

    it('user sees the placeholder when nothing is selected yet', () => {
        const wrapper = mountSelect({ modelValue: '', placeholder: 'Pick a provider' });

        expect(triggerOf(wrapper).text()).toContain('Pick a provider');

        wrapper.unmount();
    });

    it('user sees the placeholder translated when it was given as a message key', () => {
        const wrapper = mountSelect({ modelValue: '', placeholderKey: 'common.emptyOptions' });

        expect(triggerOf(wrapper).text()).toContain('No options');

        wrapper.unmount();
    });

    it('user sees the default placeholder when the caller gave none', () => {
        const wrapper = mountSelect({ modelValue: '' });

        expect(triggerOf(wrapper).text()).toContain('Select');

        wrapper.unmount();
    });

    it('user sees a trigger the caller shaped themselves instead of the default one', async () => {
        const custom = mount(CustomSelect, {
            props: { modelValue: 'openai', options, disablePortal: true },
            slots: {
                trigger: `<template #trigger="{ option, open, displayLabel }">
                    <span data-testid="custom-trigger">{{ option?.label }}|{{ open }}|{{ displayLabel }}</span>
                </template>`,
            },
            attachTo: document.body,
        });

        expect(custom.get('[data-testid="custom-trigger"]').text()).toBe('[OI]|false|');

        custom.unmount();
    });
});

describe('user gets a disabled or protected dropdown', () => {
    beforeEach(() => {
        setLocale('en-US');
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the dropdown greyed out and not clickable when it is disabled', async () => {
        const wrapper = mountSelect({ disabled: true });

        expect((triggerOf(wrapper).element as HTMLButtonElement).disabled).toBe(true);
        expect(triggerOf(wrapper).classes()).toContain('cursor-not-allowed');
        expect(triggerOf(wrapper).classes()).not.toContain('hover:bg-surface-active');

        await openList(wrapper);

        expect(listOptions(wrapper)).toHaveLength(0);

        wrapper.unmount();
    });

    it('user sees a disabled dropdown still report its selection', () => {
        const wrapper = mountSelect({ disabled: true, modelValue: 'anthropic' });

        expect(triggerOf(wrapper).text()).toContain('Anthropic');

        wrapper.unmount();
    });

    it('user does not get brand names machine-translated in the trigger or the list', async () => {
        const wrapper = mountSelect({ protectOptionText: true, modelValue: 'deepseek' });

        const triggerLabel = triggerOf(wrapper).get('span');
        expect(triggerLabel.attributes('translate')).toBe('no');
        expect(triggerLabel.attributes('data-no-i18n')).toBe('true');

        await openList(wrapper);

        const optionLabel = listOptions(wrapper)[0]!.get('span');
        expect(optionLabel.attributes('translate')).toBe('no');
        expect(optionLabel.attributes('data-no-i18n')).toBe('true');
        expect(listOptions(wrapper)[2]!.get('img').attributes('translate')).toBe('no');

        wrapper.unmount();
    });

    it('user gets no translation guard on ordinary option text', async () => {
        const wrapper = mountSelect({ protectOptionText: false, modelValue: 'openai' });

        await openList(wrapper);

        const optionLabel = listOptions(wrapper)[0]!.get('span');
        expect(optionLabel.attributes('translate')).toBeUndefined();
        expect(optionLabel.attributes('data-no-i18n')).toBeUndefined();

        wrapper.unmount();
    });

    it('user sees only the label for an option that has no description', async () => {
        const wrapper = mountSelect({ protectOptionText: true, modelValue: 'anthropic' });

        await openList(wrapper);

        expect(listOptions(wrapper)[1]!.findAll('span')).toHaveLength(1);
        expect(listOptions(wrapper)[0]!.findAll('span')).toHaveLength(2);

        wrapper.unmount();
    });
});

describe('user gets a dropdown wired to their own attributes and test ids', () => {
    beforeEach(() => {
        setLocale('en-US');
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees their test ids on the trigger and the list', async () => {
        const wrapper = mountSelect({
            triggerTestId: 'provider-trigger',
            contentTestId: 'provider-list',
        });

        expect(triggerOf(wrapper).attributes('data-testid')).toBe('provider-trigger');

        await openList(wrapper);
        expect(wrapper.find('[data-testid="provider-list"]').exists()).toBe(true);

        wrapper.unmount();
    });

    it('user sees the test id prefix applied to every option', async () => {
        const wrapper = mountSelect({ optionTestIdPrefix: 'provider-option-' });

        await openList(wrapper);

        expect(wrapper.find('[data-testid="provider-option-openai"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="provider-option-anthropic"]').exists()).toBe(true);

        wrapper.unmount();
    });

    it('user gets their own aria and data attributes on the trigger', () => {
        const wrapper = mount(CustomSelect, {
            props: { modelValue: 'openai', options, disablePortal: true },
            attrs: { 'aria-describedby': 'provider-help', 'data-form-field': 'provider' },
        });

        expect(triggerOf(wrapper).attributes('aria-describedby')).toBe('provider-help');
        expect(triggerOf(wrapper).attributes('data-form-field')).toBe('provider');

        wrapper.unmount();
    });

    it('user sees the focus and blur of the trigger reported to the form', async () => {
        const wrapper = mountSelect();

        await triggerOf(wrapper).trigger('focus');
        await triggerOf(wrapper).trigger('blur');

        expect(wrapper.emitted('focus')).toHaveLength(1);
        expect(wrapper.emitted('blur')).toHaveLength(1);

        wrapper.unmount();
    });

    it('user sees the chevron rotate while the list is open', async () => {
        const wrapper = mountSelect();

        expect(wrapper.html()).not.toContain('rotate-180');

        await openList(wrapper);

        expect(wrapper.html()).toContain('rotate-180');

        wrapper.unmount();
    });

    it('user gets the dropdown rendered as the element they asked for', () => {
        const wrapper = mount(CustomSelect, {
            props: { modelValue: 'openai', options, disablePortal: true, triggerAs: 'div' },
            attachTo: document.body,
        });

        expect(wrapper.find('div[role="combobox"]').exists()).toBe(true);
        expect(wrapper.find('button[role="combobox"]').exists()).toBe(false);

        wrapper.unmount();
    });
});
