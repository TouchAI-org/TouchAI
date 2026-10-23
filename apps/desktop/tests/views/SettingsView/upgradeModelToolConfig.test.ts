// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { ModelWithProvider } from '@database/queries/models';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import UpgradeModelToolConfig from '@/views/SettingsView/components/BuiltInTools/components/UpgradeModelToolConfig.vue';

const modelsMock = vi.hoisted(() => vi.fn());
const eventListeners = vi.hoisted(() => new Map<string, () => void | Promise<void>>());

vi.mock('@database/queries', () => ({
    findModelsWithProvider: modelsMock,
}));

vi.mock('@services/EventService', () => ({
    AppEvent: { AI_MODELS_UPDATED: 'ai-models-updated' },
    eventService: {
        on: vi.fn(async (event: string, listener: () => void | Promise<void>) => {
            eventListeners.set(event, listener);
            return () => eventListeners.delete(event);
        }),
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: { name: 'AppIcon', props: ['name'], template: '<span />' },
}));

vi.mock('@components/ModelLogo.vue', () => ({
    default: { name: 'ModelLogo', props: ['modelId', 'name'], template: '<span />' },
}));

vi.mock('@components/ModelCapabilityTags.vue', () => ({
    default: { name: 'ModelCapabilityTags', props: ['model'], template: '<span />' },
}));

// The select's own search and keyboard behavior is covered by its own test.
vi.mock('@components/SearchableSelect.vue', () => ({
    default: {
        name: 'SearchableSelect',
        props: ['modelValue', 'options', 'disabled', 'placeholderKey'],
        emits: ['update:modelValue'],
        template: `
            <select
                :data-testid="placeholderKey"
                :value="modelValue"
                :disabled="disabled"
                @change="$emit('update:modelValue', $event.target.value)"
            >
                <option v-for="option in options" :key="option.value" :value="option.value">
                    {{ option.label }}
                </option>
            </select>
        `,
    },
}));

vi.mock('vue-draggable-plus', () => ({
    VueDraggable: {
        name: 'VueDraggable',
        props: ['modelValue', 'disabled'],
        template: '<div data-testid="chain-list"><slot /></div>',
    },
}));

function model(overrides: Partial<ModelWithProvider> = {}): ModelWithProvider {
    return {
        id: 1,
        created_at: '',
        updated_at: '',
        provider_id: 1,
        model_id: 'gpt-5',
        name: 'GPT 5',
        is_default: 0,
        last_used_at: null,
        attachment: 0,
        modalities: null,
        open_weights: 0,
        reasoning: 0,
        reasoning_options: null,
        release_date: null,
        temperature: 1,
        tool_call: 1,
        knowledge: null,
        context_limit: null,
        output_limit: null,
        is_custom_metadata: 0,
        upstream_metadata: null,
        provider_name: 'Acme',
        provider_driver: 'openai',
        api_endpoint: 'https://api.example.com',
        api_key: null,
        provider_config_json: null,
        provider_enabled: 1,
        provider_logo: 'openai.png',
        ...overrides,
    };
}

const catalog: ModelWithProvider[] = [
    model({ id: 1, provider_id: 1, provider_name: 'Acme', model_id: 'gpt-5', name: 'GPT 5' }),
    model({
        id: 2,
        provider_id: 1,
        provider_name: 'Acme',
        model_id: 'gpt-5-mini',
        name: 'GPT 5 Mini',
    }),
    model({
        id: 3,
        provider_id: 2,
        provider_name: 'Beta',
        provider_driver: 'anthropic',
        model_id: 'claude',
        name: 'Claude',
    }),
];

function mountConfig(chain: Array<{ providerId: number; modelId: string }> = []) {
    return mount(UpgradeModelToolConfig, {
        props: { modelValue: { chain } },
    });
}

function rows(wrapper: ReturnType<typeof mountConfig>) {
    return wrapper.findAll('[data-row-uid]');
}

/** The most recent chain the component asked the parent to save. */
function lastUpdate(wrapper: ReturnType<typeof mountConfig>) {
    const emitted = wrapper.emitted('update:modelValue') ?? [];
    return emitted[emitted.length - 1];
}

beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
    setLocale('zh-CN');
    modelsMock.mockResolvedValue(catalog);
});

describe('user sets the upgrade fallback chain', () => {
    it('user is invited to add the first model when the chain is empty', async () => {
        const wrapper = mountConfig();
        await flushPromises();

        expect(wrapper.text()).toContain('模型升级链');
        expect(wrapper.text()).toContain('暂未配置升级链');
        expect(wrapper.text()).toContain('添加模型');
        expect(rows(wrapper)).toHaveLength(0);
    });

    it('user sees one card per model already in the chain', async () => {
        const wrapper = mountConfig([
            { providerId: 1, modelId: 'gpt-5' },
            { providerId: 2, modelId: 'claude' },
        ]);
        await flushPromises();

        expect(rows(wrapper)).toHaveLength(2);
    });

    it('user adds the first available model to the chain', async () => {
        const wrapper = mountConfig();
        await flushPromises();

        await wrapper.get('[aria-label="添加模型"]').trigger('click');
        await flushPromises();

        expect(lastUpdate(wrapper)).toEqual([{ chain: [{ providerId: 1, modelId: 'gpt-5' }] }]);
        expect(rows(wrapper)).toHaveLength(1);
    });

    it('user cannot add a model that is already in the chain twice', async () => {
        const wrapper = mountConfig(
            catalog.map((entry) => ({
                providerId: entry.provider_id,
                modelId: entry.model_id,
            }))
        );
        await flushPromises();

        expect(wrapper.get('[aria-label="添加模型"]').attributes('disabled')).toBeDefined();
    });

    it('user sees the chain follow the config when it changes elsewhere', async () => {
        const wrapper = mountConfig();
        await flushPromises();

        await wrapper.setProps({
            modelValue: { chain: [{ providerId: 2, modelId: 'claude' }] },
        });
        await flushPromises();

        expect(rows(wrapper)).toHaveLength(1);
        expect(wrapper.text()).toContain('Beta');
    });

    it('user removes a model from the chain', async () => {
        const wrapper = mountConfig([
            { providerId: 1, modelId: 'gpt-5' },
            { providerId: 2, modelId: 'claude' },
        ]);
        await flushPromises();

        const cardButtons = rows(wrapper)[0]!.findAll('button');
        await cardButtons[cardButtons.length - 1]!.trigger('click');
        await flushPromises();

        expect(lastUpdate(wrapper)).toEqual([{ chain: [{ providerId: 2, modelId: 'claude' }] }]);
    });

    it('user picks a different model within the same provider', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();
        const modelSelect = wrapper
            .findAll('select')
            .find((select) => select.attributes('data-testid')?.includes('model'))!;

        await modelSelect.setValue('gpt-5-mini');
        await flushPromises();

        expect(lastUpdate(wrapper)).toEqual([
            { chain: [{ providerId: 1, modelId: 'gpt-5-mini' }] },
        ]);
    });

    it('user switching provider moves the row to that provider’s first model', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();
        const providerSelect = wrapper
            .findAll('select')
            .find((select) => select.attributes('data-testid')?.includes('provider'))!;

        await providerSelect.setValue('2');
        await flushPromises();

        expect(lastUpdate(wrapper)).toEqual([{ chain: [{ providerId: 2, modelId: 'claude' }] }]);
    });

    it('user sees the chain reload when models are added elsewhere in the app', async () => {
        const wrapper = mountConfig();
        await flushPromises();
        expect(rows(wrapper)).toHaveLength(0);

        modelsMock.mockResolvedValue([
            ...catalog,
            model({
                id: 4,
                provider_id: 3,
                provider_name: 'Gamma',
                model_id: 'gemini',
                name: 'Gemini',
            }),
        ]);
        await eventListeners.get('ai-models-updated')?.();
        await flushPromises();

        await wrapper.get('[aria-label="添加模型"]').trigger('click');
        await flushPromises();

        expect(lastUpdate(wrapper)).toEqual([{ chain: [{ providerId: 1, modelId: 'gpt-5' }] }]);
        expect(modelsMock).toHaveBeenCalledTimes(2);
    });

    it('user is told to configure models first when none are enabled', async () => {
        modelsMock.mockResolvedValue([model({ provider_enabled: 0 })]);
        const wrapper = mountConfig();
        await flushPromises();

        expect(wrapper.text()).toContain('先在「服务商与模型」中启用服务商并获取模型');
        expect(wrapper.get('[aria-label="添加模型"]').attributes('disabled')).toBeDefined();
    });

    it('user still sees an empty chain when the model list cannot be loaded', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        modelsMock.mockRejectedValue(new Error('database unavailable'));
        const wrapper = mountConfig();
        await flushPromises();

        expect(rows(wrapper)).toHaveLength(0);
        expect(wrapper.get('[aria-label="添加模型"]').attributes('disabled')).toBeDefined();
        consoleError.mockRestore();
    });

    it('user sees the English empty state when the app is in English', async () => {
        setLocale('en-US');

        const wrapper = mountConfig();
        await flushPromises();

        expect(wrapper.text()).toContain('Model upgrade chain');
        expect(wrapper.text()).toContain('No upgrade chain configured');
    });
});
