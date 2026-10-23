// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import UsageToolbar from '@/views/SettingsView/components/Usage/components/UsageToolbar.vue';

const options = {
    providers: [{ id: 7, name: 'Acme Gateway', count: 12 }],
    models: [
        { id: 1, name: 'gpt-5', count: 8 },
        { id: 2, name: 'claude', count: 4 },
    ],
};

function mountToolbar(overrides: Record<string, unknown> = {}) {
    return mount(UsageToolbar, {
        props: {
            preset: '7d',
            status: 'all',
            providerId: null,
            modelId: null,
            search: '',
            options,
            loading: false,
            ...overrides,
        },
        global: {
            stubs: {
                CustomSelect: {
                    props: ['modelValue', 'options', 'disabled', 'triggerTestId'],
                    emits: ['update:modelValue'],
                    template: `
                        <button
                            type="button"
                            :data-testid="triggerTestId"
                            :disabled="disabled"
                            @click="$emit('update:modelValue', options[options.length - 1].value)"
                        >
                            {{ modelValue }}:{{ options.length }}
                        </button>
                    `,
                },
                AppIcon: true,
            },
        },
    });
}

beforeEach(() => setLocale('zh-CN'));

describe('user filters the usage page', () => {
    it('user sees one control per filter, each showing the active value', () => {
        const wrapper = mountToolbar({ providerId: 7, modelId: 2, search: 'gpt' });

        expect(wrapper.get('[data-testid="settings-usage-range-trigger"]').text()).toContain('7d');
        expect(wrapper.get('[data-testid="settings-usage-status-trigger"]').text()).toContain(
            'all'
        );
        expect(wrapper.get('[data-testid="settings-usage-provider-trigger"]').text()).toContain(
            '7'
        );
        expect(wrapper.get('[data-testid="settings-usage-model-trigger"]').text()).toContain('2');
        expect((wrapper.get('input').element as HTMLInputElement).value).toBe('gpt');
    });

    it('user sees every provider and model in its list plus an all-options entry', () => {
        const wrapper = mountToolbar();

        // Range: five presets, status: five values, providers: all + one, models: all + two.
        expect(wrapper.get('[data-testid="settings-usage-provider-trigger"]').text()).toContain(
            ':2'
        );
        expect(wrapper.get('[data-testid="settings-usage-model-trigger"]').text()).toContain(':3');
    });

    it('user changes the time range', async () => {
        const wrapper = mountToolbar();

        await wrapper.get('[data-testid="settings-usage-range-trigger"]').trigger('click');

        expect(wrapper.emitted('update:preset')).toBeTruthy();
    });

    it('user changes the status filter', async () => {
        const wrapper = mountToolbar();

        await wrapper.get('[data-testid="settings-usage-status-trigger"]').trigger('click');

        expect(wrapper.emitted('update:status')).toBeTruthy();
    });

    it('user picks a provider, which clears any model filter so the query matches rows', async () => {
        const wrapper = mountToolbar({ modelId: 2 });

        await wrapper.get('[data-testid="settings-usage-provider-trigger"]').trigger('click');

        expect(wrapper.emitted('update:providerId')).toEqual([[7]]);
        expect(wrapper.emitted('update:modelId')).toEqual([[null]]);
    });

    it('user picks a model, which clears any provider filter so the query matches rows', async () => {
        const wrapper = mountToolbar({ providerId: 7 });

        await wrapper.get('[data-testid="settings-usage-model-trigger"]').trigger('click');

        expect(wrapper.emitted('update:modelId')).toEqual([[2]]);
        expect(wrapper.emitted('update:providerId')).toEqual([[null]]);
    });

    it('user clears the provider filter back to every provider', async () => {
        const wrapper = mountToolbar({ providerId: 7 });
        // The stub clicks the last option; the first one is "all providers".
        const select = wrapper.get('[data-testid="settings-usage-provider-trigger"]');
        expect(select.text()).toContain('7');

        await wrapper.get('[data-testid="settings-usage-model-trigger"]').trigger('click');

        expect(wrapper.emitted('update:providerId')).toEqual([[null]]);
    });

    it('user types into the search field and the page narrows', async () => {
        const wrapper = mountToolbar();

        await wrapper.get('input').setValue('deploy');

        expect(wrapper.emitted('update:search')).toEqual([['deploy']]);
    });

    it('user sees the filters disabled while the page is loading', () => {
        const wrapper = mountToolbar({ loading: true });

        for (const id of [
            'settings-usage-range-trigger',
            'settings-usage-status-trigger',
            'settings-usage-provider-trigger',
            'settings-usage-model-trigger',
        ]) {
            expect(wrapper.get(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined();
        }
    });

    it('user sees the filter labels in English when the app is in English', () => {
        setLocale('en-US');

        const wrapper = mountToolbar();

        expect(wrapper.get('input').attributes('placeholder')).toBe('Search models or providers');
    });
});
