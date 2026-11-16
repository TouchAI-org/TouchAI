import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import ModelDropdownPopup from '@/views/SearchView/components/ModelDropdownPopup/index.vue';
import type { ModelDropdownData } from '@/views/SearchView/types';

const data = {
    activeModelId: 'gpt-6',
    activeProviderId: 1,
    selectedModelId: '',
    selectedProviderId: null,
    searchQuery: '',
    toggleShortcut: 'Mod+M',
    reasoningLevel: 'high',
    models: [
        {
            id: 10,
            modelId: 'gpt-6',
            name: 'GPT-6',
            providerId: 1,
            providerName: 'OpenAI',
            providerDriver: 'openai',
            providerLogo: 'openai.png',
            reasoning: 1,
            reasoningLevels: ['low', 'medium', 'high', 'max'],
            tool_call: 1,
            modalities: null,
            attachment: 1,
            open_weights: 0,
        },
        {
            id: 20,
            modelId: 'claude-sonnet',
            name: 'Claude Sonnet',
            providerId: 2,
            providerName: 'Anthropic',
            providerDriver: 'anthropic',
            providerLogo: 'anthropic.png',
            reasoning: 1,
            reasoningLevels: ['low', 'high'],
            tool_call: 1,
            modalities: null,
            attachment: 1,
            open_weights: 0,
        },
        {
            id: 30,
            modelId: 'plain',
            name: 'Plain model',
            providerId: 2,
            providerName: 'Anthropic',
            providerLogo: 'anthropic.png',
            reasoning: 0,
            reasoningLevels: [],
            tool_call: 0,
            modalities: null,
            attachment: 0,
            open_weights: 0,
        },
    ],
} as ModelDropdownData;

const wrappers: ReturnType<typeof mount>[] = [];

async function openSortMenu(wrapper: ReturnType<typeof mount>) {
    await wrapper.get('[data-sort-trigger]').trigger('click');
    await flushPromises();
}

async function clickSortItem(wrapper: ReturnType<typeof mount>, selector: string) {
    const item = document.querySelector<HTMLElement>(selector);
    if (!item) throw new Error(`sort item missing: ${selector}`);
    item.click();
    await flushPromises();
    expect(wrapper.find('[data-sort-trigger]').attributes('aria-expanded')).toBe('false');
}
function renderPicker(onModelSelect = vi.fn().mockResolvedValue(undefined)) {
    const wrapper = mount(ModelDropdownPopup, {
        attachTo: document.body,
        props: { data, onModelSelect },
    });
    wrappers.push(wrapper);
    return { wrapper, onModelSelect };
}

beforeEach(() => {
    setLocale('en-US');
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));

describe('given models from two providers and different reasoning capabilities', () => {
    it('user arrows from a focused model and activates the newly highlighted model with Space', async () => {
        const { wrapper, onModelSelect } = renderPicker();
        (wrapper.get('[data-model-id="10"]').element as HTMLElement).focus();
        await wrapper.get('[data-model-id="10"]').trigger('keydown', { key: 'ArrowDown' });
        await flushPromises();
        expect(document.activeElement?.getAttribute('data-model-id')).toBe('20');
        // Native Space activation clicks the focused button.
        (document.activeElement as HTMLElement).click();
        await flushPromises();
        expect(onModelSelect).toHaveBeenCalledWith(20, 'high');
    });

    it('user arrows in the filter and keeps typing focus while the active option changes', async () => {
        const { wrapper } = renderPicker();
        (wrapper.get('input').element as HTMLElement).focus();
        await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' });
        await flushPromises();
        expect(document.activeElement).toBe(wrapper.get('input').element);
        expect(wrapper.get('input').attributes('aria-activedescendant')).toBe(
            wrapper.get('[data-model-id="20"]').attributes('id')
        );
    });

    it('user uses the provider logo column as a list index without filtering', async () => {
        const { wrapper } = renderPicker();

        expect(wrapper.get('nav').findAll('button')).toHaveLength(3);
        await wrapper.get('button[aria-label="Anthropic"]').trigger('click');
        expect(wrapper.findAll('[role="option"]')).toHaveLength(3);
        expect(wrapper.get('[data-model-id="20"]').attributes('data-highlighted')).toBe('true');
    });

    it('user sorts the visible models by name, vendor, or provider and reverses the direction', async () => {
        const { wrapper } = renderPicker();
        const optionNames = () =>
            wrapper
                .findAll('[role="option"]')
                .map((row) => row.attributes('title')!.split(' · ')[0]);

        await openSortMenu(wrapper);
        await clickSortItem(wrapper, '[data-sort-field="name"]');
        expect(optionNames()).toEqual(['Claude Sonnet', 'GPT-6', 'Plain model']);

        await openSortMenu(wrapper);
        await clickSortItem(wrapper, '[data-sort-field="provider"]');
        expect(optionNames()).toEqual(['Claude Sonnet', 'Plain model', 'GPT-6']);

        await openSortMenu(wrapper);
        await clickSortItem(wrapper, '[data-sort-direction="true"]');
        expect(optionNames()).toEqual(['GPT-6', 'Plain model', 'Claude Sonnet']);
    });

    it('user chooses a visible model with its displayed numeric shortcut', async () => {
        const { wrapper, onModelSelect } = renderPicker();
        await wrapper.get('input').setValue('sonnet');
        expect(wrapper.get('[role="option"]').text()).toContain('Ctrl+1');
        await wrapper.get('input').trigger('keydown', { key: '1', ctrlKey: true });
        await flushPromises();
        expect(onModelSelect).toHaveBeenCalledWith(20, 'high');
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('user sees only supported depths and commits the highlighted model with a chosen depth', async () => {
        const { wrapper, onModelSelect } = renderPicker();
        await wrapper.findAll('[role="option"]')[1]!.trigger('mouseenter');
        expect(wrapper.findAll('[data-reasoning-level]').map((row) => row.text())).toEqual([
            'Low',
            expect.stringContaining('High'),
        ]);
        await wrapper.get('[data-reasoning-level="low"]').trigger('click');
        await flushPromises();
        expect(onModelSelect).toHaveBeenCalledWith(20, 'low');
    });

    it('user sees the current depth on reopening and cannot choose a depth for a plain model', async () => {
        const { wrapper } = renderPicker();
        expect(wrapper.get('[data-reasoning-level="high"]').attributes('aria-checked')).toBe(
            'true'
        );
        await wrapper.findAll('[role="option"]')[2]!.trigger('mouseenter');
        expect(wrapper.findAll('[data-reasoning-level]')).toHaveLength(0);
        expect(wrapper.text()).toContain('Reasoning unavailable');
    });

    it('user keeps the picker open with an error when selection fails and can retry', async () => {
        const select = vi
            .fn()
            .mockRejectedValueOnce(new Error('Model unavailable'))
            .mockResolvedValue(undefined);
        const { wrapper } = renderPicker(select);
        await wrapper.get('[role="option"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toContain('Could not select');
        expect(wrapper.emitted('close')).toBeUndefined();
        await wrapper.get('[role="option"]').trigger('click');
        await flushPromises();
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('user can navigate model and depth columns without selecting during composition', async () => {
        const { wrapper, onModelSelect } = renderPicker();
        await wrapper.get('input').trigger('keydown', { key: 'Enter', isComposing: true });
        expect(onModelSelect).not.toHaveBeenCalled();
        await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' });
        await wrapper.get('input').trigger('keydown', { key: 'ArrowRight' });
        expect(document.activeElement?.getAttribute('data-reasoning-level')).toBe('high');
        await wrapper.get('[data-reasoning-level="high"]').trigger('keydown', { key: 'ArrowUp' });
        await wrapper.get('[data-reasoning-level="low"]').trigger('keydown', { key: 'Enter' });
        await flushPromises();
        expect(onModelSelect).toHaveBeenCalledWith(20, 'low');
    });
});
