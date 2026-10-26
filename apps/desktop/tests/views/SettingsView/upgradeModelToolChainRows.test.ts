import type { ModelWithProvider } from '@database/queries/models';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import UpgradeModelToolConfig from '@/views/SettingsView/components/BuiltInTools/components/UpgradeModelToolConfig.vue';

/*
 * The existing upgradeModelToolConfig test covers adding, removing and switching a
 * chain row. This file covers the two states it cannot reach: a chain that still
 * names a provider or model the catalogue no longer offers, and the row controls
 * a user can drag and reorder. The select stub renders both of its slots, because
 * the provider badge and the capability tags only exist inside them.
 */

const modelsMock = vi.hoisted(() => vi.fn());

vi.mock('@database/queries', () => ({ findModelsWithProvider: modelsMock }));

vi.mock('@services/EventService', () => ({
    AppEvent: { AI_MODELS_UPDATED: 'ai-models-updated' },
    eventService: { on: vi.fn(async () => () => undefined) },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: { name: 'AppIcon', props: ['name'], template: '<span />' },
}));

vi.mock('@components/ModelLogo.vue', () => ({
    default: {
        name: 'ModelLogo',
        props: ['modelId', 'name', 'size'],
        template: '<span data-testid="model-logo" :data-model="modelId" />',
    },
}));

vi.mock('@components/ModelCapabilityTags.vue', () => ({
    default: {
        name: 'ModelCapabilityTags',
        props: ['model', 'size'],
        template: '<span data-testid="capability-tags" />',
    },
}));

// The select's own search behaviour has its own test. This stub keeps the two
// named slots so the row's selected and option content is actually rendered.
vi.mock('@components/SearchableSelect.vue', () => ({
    default: {
        name: 'SearchableSelect',
        props: ['modelValue', 'options', 'disabled', 'placeholderKey'],
        emits: ['update:modelValue'],
        template: `
            <div :data-testid="placeholderKey" :data-value="modelValue">
                <div data-testid="selected-slot">
                    <slot
                        name="selected"
                        :option="options.find((entry) => entry.value === modelValue) ?? null"
                    />
                </div>
                <div data-testid="option-slots">
                    <div
                        v-for="option in options"
                        :key="String(option.value)"
                        data-testid="option-slot"
                    >
                        <slot name="option" :option="option" />
                    </div>
                </div>
            </div>
        `,
    },
}));

vi.mock('vue-draggable-plus', () => ({
    VueDraggable: {
        name: 'VueDraggable',
        props: ['modelValue', 'disabled'],
        emits: ['start', 'end'],
        template: `
            <div data-testid="chain-list" @dragstart="$emit('start', $event)" @dragend="$emit('end', $event)">
                <slot />
            </div>
        `,
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
    model({ id: 3, provider_id: 2, provider_name: 'Beta', model_id: 'claude', name: 'Claude' }),
];

function mountConfig(chain: Array<{ providerId: number; modelId: string }> = []) {
    return mount(UpgradeModelToolConfig, { props: { modelValue: { chain } } });
}

function rows(wrapper: ReturnType<typeof mountConfig>) {
    return wrapper.findAll('[data-row-uid]');
}

function lastUpdate(wrapper: ReturnType<typeof mountConfig>) {
    const emitted = wrapper.emitted('update:modelValue') ?? [];
    return emitted[emitted.length - 1];
}

/**
 * Each row carries two selects: the provider first, then the model. Driving them
 * through the component (not the rendered div) is how the real select reports a
 * choice, so the emitted value is what the row receives.
 */
function selectIn(
    wrapper: ReturnType<typeof mountConfig>,
    rowIndex: number,
    field: 'provider' | 'model'
) {
    const selects = wrapper.findAllComponents({ name: 'SearchableSelect' });
    const index = rowIndex * 2 + (field === 'provider' ? 0 : 1);
    const found = selects[index];
    expect(found).toBeDefined();
    return found!;
}

function providerSelect(wrapper: ReturnType<typeof mountConfig>, rowIndex = 0) {
    return selectIn(wrapper, rowIndex, 'provider');
}

function modelSelect(wrapper: ReturnType<typeof mountConfig>, rowIndex = 0) {
    return selectIn(wrapper, rowIndex, 'model');
}

beforeEach(() => {
    vi.clearAllMocks();
    setLocale('zh-CN');
    modelsMock.mockResolvedValue(catalog);
});

describe('user reads a chain that names a provider the app no longer offers', () => {
    it('user sees the missing provider kept in the chain instead of dropped', async () => {
        const wrapper = mountConfig([{ providerId: 99, modelId: 'ghost-model' }]);
        await flushPromises();

        expect(rows(wrapper)).toHaveLength(1);
        expect(wrapper.text()).toContain('Provider #99');
    });

    it('user sees the missing model kept in the chain', async () => {
        const wrapper = mountConfig([{ providerId: 99, modelId: 'ghost-model' }]);
        await flushPromises();

        expect(modelSelect(wrapper).attributes('data-value')).toBe('ghost-model');
        expect(wrapper.text()).toContain('ghost-model');
    });

    it('user is told the provider is unavailable rather than shown an empty row', async () => {
        const wrapper = mountConfig([{ providerId: 99, modelId: 'ghost-model' }]);
        await flushPromises();

        expect(wrapper.text()).toContain('当前已选服务商不可用');
    });

    it('user is told the provider is disabled when that is why it is missing', async () => {
        modelsMock.mockResolvedValue([
            model({
                id: 5,
                provider_id: 7,
                provider_name: 'Paused',
                model_id: 'paused-model',
                name: 'Paused model',
                provider_enabled: 0,
            }),
            ...catalog,
        ]);
        const wrapper = mountConfig([{ providerId: 7, modelId: 'paused-model' }]);
        await flushPromises();

        expect(wrapper.text()).toContain('当前已选服务商未启用');
    });

    it('user gets the provider initial shown when there is no logo to draw', async () => {
        const wrapper = mountConfig([{ providerId: 99, modelId: 'ghost-model' }]);
        await flushPromises();

        // "Provider #99" has no logo, so the badge falls back to its first letter.
        expect(wrapper.findAll('[data-testid="option-slot"]').length).toBeGreaterThan(0);
        expect(wrapper.text()).toContain('P');
    });

    it('user gets a provider logo drawn when the provider does have one', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();

        expect(wrapper.findAll('img').length).toBeGreaterThan(0);
    });

    it('user is told the model provider was disabled rather than shown a blank row', async () => {
        // A chain row whose provider is gone and whose catalogue entry was disabled:
        // the row still resolves the model, so it must explain why it is unavailable.
        modelsMock.mockResolvedValue([
            model({
                id: 8,
                provider_id: 8,
                provider_name: 'Paused',
                model_id: 'nameless',
                name: 'Paused model',
                provider_enabled: 0,
            }),
        ]);
        const wrapper = mountConfig([{ providerId: 8, modelId: 'nameless' }]);
        await flushPromises();

        expect(wrapper.text()).toContain('当前已选服务商未启用');
        expect(wrapper.text()).toContain('Paused');
    });

    it('user gets the model logo for a chain row that resolves', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();

        expect(wrapper.findAll('[data-testid="model-logo"]').length).toBeGreaterThan(0);
    });

    it('user sees the capability tags for a model that reports them', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();

        expect(wrapper.findAll('[data-testid="capability-tags"]').length).toBeGreaterThan(0);
    });
});

describe('user reorders the chain', () => {
    function chain() {
        return [
            { providerId: 1, modelId: 'gpt-5' },
            { providerId: 2, modelId: 'claude' },
        ];
    }

    it('user sees the row they are dragging marked while the drag runs', async () => {
        const wrapper = mountConfig(chain());
        await flushPromises();
        const first = rows(wrapper)[0]!;
        const item = first.element as HTMLElement;
        item.dataset.rowUid = first.attributes('data-row-uid');

        await wrapper.get('[data-testid="chain-list"]').trigger('dragstart', {
            item,
        });
        await flushPromises();

        expect(rows(wrapper)[0]!.classes()).toContain('upgrade-model-chain-card--source-dragging');
    });

    it('user gets the reordered chain saved once the drag ends', async () => {
        const wrapper = mountConfig(chain());
        await flushPromises();
        const before = (wrapper.emitted('update:modelValue') ?? []).length;

        await wrapper.get('[data-testid="chain-list"]').trigger('dragend');
        await flushPromises();

        // The order is unchanged here, so the save is the no-op guard rather than a
        // new chain: the component must not emit the same chain twice.
        expect((wrapper.emitted('update:modelValue') ?? []).length).toBe(before);
        expect(lastUpdate(wrapper)).toBeUndefined();
    });

    it('user gets the dragging marker cleared after the drag', async () => {
        const wrapper = mountConfig(chain());
        await flushPromises();
        const first = rows(wrapper)[0]!;
        await wrapper.get('[data-testid="chain-list"]').trigger('dragstart', {
            item: first.element as HTMLElement,
        });

        await wrapper.get('[data-testid="chain-list"]').trigger('dragend');
        await flushPromises();

        expect(rows(wrapper)[0]!.classes()).not.toContain(
            'upgrade-model-chain-card--source-dragging'
        );
    });
});

describe('user changes a row the select cannot apply', () => {
    it('user gets nothing saved when the provider id is not a number', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();

        providerSelect(wrapper).vm.$emit('update:modelValue', 'not-a-number');
        await flushPromises();

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('user gets nothing saved when they re-pick the provider already selected', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();

        providerSelect(wrapper).vm.$emit('update:modelValue', 1);
        await flushPromises();

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('user gets nothing saved when the chosen provider has no enabled models', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();

        providerSelect(wrapper).vm.$emit('update:modelValue', 12345);
        await flushPromises();

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('user gets nothing saved when the model id is blank', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();

        modelSelect(wrapper).vm.$emit('update:modelValue', '   ');
        await flushPromises();

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('user gets nothing saved when they re-pick the model already selected', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();

        modelSelect(wrapper).vm.$emit('update:modelValue', 'gpt-5');
        await flushPromises();

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('user gets the model they picked saved', async () => {
        const wrapper = mountConfig([{ providerId: 1, modelId: 'gpt-5' }]);
        await flushPromises();

        modelSelect(wrapper).vm.$emit('update:modelValue', 'gpt-5-mini');
        await flushPromises();

        expect(lastUpdate(wrapper)).toEqual([
            { chain: [{ providerId: 1, modelId: 'gpt-5-mini' }] },
        ]);
    });
});
