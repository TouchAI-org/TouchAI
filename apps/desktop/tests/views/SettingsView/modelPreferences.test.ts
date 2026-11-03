import type { ModelWithProvider } from '@database/queries/models';
import type { ModelPreferenceWithModel } from '@database/types';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import ModelPreferences from '@/views/SettingsView/components/ModelPreferences/index.vue';

const settingsStoreMock = vi.hoisted(() => ({
    settings: {
        __v_isRef: true,
        value: {
            allowModelAutoSwitch: false,
        },
    },
    initialize: vi.fn(),
    updateAllowModelAutoSwitch: vi.fn(),
}));

const queriesMock = vi.hoisted(() => ({
    createModelPreference: vi.fn(),
    deleteModelPreference: vi.fn(),
    findModelRoleWithProvider: vi.fn(),
    findModelsWithProvider: vi.fn(),
    listModelPreferences: vi.fn(),
    setModelRole: vi.fn(),
    updateModelPreference: vi.fn(),
}));

const alertMock = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
}));

const confirmMock = vi.hoisted(() => vi.fn());
const eventOnMock = vi.hoisted(() => vi.fn());
const unlistenMock = vi.hoisted(() => vi.fn());

vi.mock('pinia', () => ({
    storeToRefs: (store: typeof settingsStoreMock) => ({
        settings: store.settings,
    }),
}));

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => settingsStoreMock,
}));

vi.mock('@database/queries', () => queriesMock);

vi.mock('@composables/useAlert', () => ({
    useAlert: () => alertMock,
}));

vi.mock('@composables/useConfirm', () => ({
    useConfirm: () => ({ confirm: confirmMock }),
}));

vi.mock('@services/EventService', () => ({
    AppEvent: { AI_MODELS_UPDATED: 'ai-models-updated' },
    eventService: { on: eventOnMock },
}));

vi.mock('@services/ObservabilityService', () => ({
    log: {
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/LoadingState.vue', () => ({
    default: {
        name: 'LoadingState',
        template: '<div data-testid="loading-state" />',
    },
}));

vi.mock('@components/DialogShell.vue', () => ({
    default: {
        name: 'DialogShell',
        template: '<section data-testid="dialog-shell"><slot /></section>',
    },
}));

vi.mock('@components/SearchableSelect.vue', () => ({
    default: {
        name: 'SearchableSelect',
        props: ['modelValue', 'options', 'disabled'],
        emits: ['update:modelValue'],
        methods: {
            emitValue(this: { $emit: (event: string, value: string) => void }, event: Event) {
                this.$emit('update:modelValue', (event.target as HTMLSelectElement).value);
            },
        },
        template: `
            <select :value="modelValue" :disabled="disabled" @change="emitValue">
                <option v-for="option in options" :key="option.value" :value="option.value">
                    {{ option.label }}
                </option>
            </select>
        `,
    },
}));

vi.mock('@components/ui/switch', () => ({
    Switch: {
        name: 'Switch',
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template:
            '<button type="button" :aria-checked="String(modelValue)" :disabled="disabled" @click="$emit(\'update:modelValue\', !modelValue)" />',
    },
}));

enableAutoUnmount(afterEach);

function createModel(overrides: Partial<ModelWithProvider>): ModelWithProvider {
    return {
        id: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        provider_id: 1,
        model_id: 'fast-model',
        name: 'Fast model',
        is_default: 1,
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
        provider_name: 'Provider A',
        provider_driver: 'openai',
        api_endpoint: 'https://example.test',
        api_key: null,
        provider_config_json: null,
        provider_enabled: 1,
        provider_logo: '',
        ...overrides,
    };
}

function createPreference(
    overrides: Partial<ModelPreferenceWithModel> = {}
): ModelPreferenceWithModel {
    return {
        id: 'preference-1',
        name: 'Frontend',
        description: 'React and Vue work',
        provider_id: 1,
        model_id: 1,
        priority: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        model_name: 'Fast model',
        model_api_id: 'fast-model',
        model_provider_id: 1,
        provider_name: 'Provider A',
        provider_enabled: 1,
        ...overrides,
    };
}

const fastModel = createModel({});
const generalModel = createModel({
    id: 2,
    model_id: 'general-model',
    name: 'General model',
    is_default: 0,
});

function configureHappyPath() {
    queriesMock.findModelsWithProvider.mockResolvedValue([fastModel, generalModel]);
    queriesMock.listModelPreferences.mockResolvedValue([createPreference()]);
    queriesMock.findModelRoleWithProvider.mockImplementation(async (role: string) => {
        if (role === 'entry') return fastModel;
        if (role === 'general') return generalModel;
        return null;
    });
}

beforeEach(() => {
    vi.resetAllMocks();
    setLocale('en-US');
    settingsStoreMock.settings.value = { allowModelAutoSwitch: false };
    settingsStoreMock.initialize.mockResolvedValue(undefined);
    settingsStoreMock.updateAllowModelAutoSwitch.mockImplementation(async (enabled: boolean) => {
        settingsStoreMock.settings.value = { allowModelAutoSwitch: enabled };
    });
    confirmMock.mockResolvedValue(true);
    unlistenMock.mockReset();
    eventOnMock.mockResolvedValue(unlistenMock);
    configureHappyPath();
});

describe('user configures model routing', () => {
    it('user sees base roles and scenario models in one page', async () => {
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        expect(wrapper.text()).toContain('Model routing');
        expect(wrapper.text()).toContain('Base models');
        expect(wrapper.text()).toContain('Default model');
        expect(wrapper.text()).toContain('Fast model');
        expect(wrapper.text()).toContain('General model');
        expect(wrapper.text()).toContain('Scenario models');
        expect(wrapper.text()).toContain('Frontend');
        expect(wrapper.text()).toContain('React and Vue work');
        expect(wrapper.text()).toContain('Provider A / Fast model');
    });

    it('user turns model routing on and off without disabling the configuration', async () => {
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        const toggle = wrapper.get('[data-testid="model-routing-toggle"]');
        const roleSelect = wrapper.get('[data-testid="model-routing-fast-select"]');
        expect(roleSelect.attributes('disabled')).toBeUndefined();

        await toggle.trigger('click');
        await flushPromises();
        expect(settingsStoreMock.updateAllowModelAutoSwitch).toHaveBeenNthCalledWith(1, true);

        await toggle.trigger('click');
        await flushPromises();
        expect(settingsStoreMock.updateAllowModelAutoSwitch).toHaveBeenNthCalledWith(2, false);
        expect(
            wrapper.get('[data-testid="model-routing-fast-select"]').attributes('disabled')
        ).toBe(undefined);
    });

    it('user sees the routing switch roll back when saving it fails', async () => {
        settingsStoreMock.updateAllowModelAutoSwitch.mockRejectedValueOnce(new Error('disk full'));
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        await wrapper.get('[data-testid="model-routing-toggle"]').trigger('click');
        await flushPromises();

        expect(alertMock.error).toHaveBeenCalledWith('Failed to save model routing');
        expect(settingsStoreMock.settings.value.allowModelAutoSwitch).toBe(false);
        expect(wrapper.get('[data-testid="model-routing-toggle"]').attributes('aria-checked')).toBe(
            'false'
        );
    });

    it('user changes a base role model and the selection is saved', async () => {
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        await wrapper.get('[data-testid="model-routing-general-select"]').setValue('1');
        await flushPromises();

        expect(queriesMock.setModelRole).toHaveBeenCalledWith({
            role: 'general',
            modelId: 1,
        });
    });

    it('user can clear an optional role back to the default model', async () => {
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        await wrapper
            .get('[data-testid="model-routing-general-select"]')
            .setValue('__touchai_unset_model__');
        await flushPromises();

        expect(queriesMock.setModelRole).toHaveBeenCalledWith({
            role: 'general',
            modelId: null,
        });
    });

    it('user sees an unavailable scenario target flagged', async () => {
        queriesMock.listModelPreferences.mockResolvedValue([
            createPreference({
                model_id: 99,
                model_name: 'Removed model',
                provider_enabled: 0,
            }),
        ]);
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        expect(wrapper.get('[data-testid="model-routing-preference-unavailable"]').text()).toBe(
            'Target model unavailable'
        );
    });

    it('user sees an empty state when no enabled model exists', async () => {
        queriesMock.findModelsWithProvider.mockResolvedValue([
            createModel({ provider_enabled: 0 }),
        ]);
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        expect(wrapper.text()).toContain('No models available');
        expect(wrapper.find('[data-testid="model-routing-add"]').exists()).toBe(false);
    });

    it('user sees an empty state when no scenario has been added', async () => {
        queriesMock.listModelPreferences.mockResolvedValue([]);
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        expect(wrapper.text()).toContain('No scenario models yet');
    });

    it('user creates a scenario through the dialog', async () => {
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        await wrapper.get('[data-testid="model-routing-add"]').trigger('click');
        await wrapper.get('[data-testid="model-preference-name"]').setValue('Backend');
        await wrapper
            .get('[data-testid="model-preference-description"]')
            .setValue('API and database work');
        await wrapper.get('[data-testid="model-preference-save"]').trigger('click');
        await flushPromises();

        expect(queriesMock.createModelPreference).toHaveBeenCalledWith({
            name: 'Backend',
            description: 'API and database work',
            model_id: 1,
        });
        expect(wrapper.find('[data-testid="dialog-shell"]').exists()).toBe(false);
    });

    it('user edits an existing scenario through the dialog', async () => {
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        await wrapper.get('[aria-label="Edit"]').trigger('click');
        await wrapper.get('[data-testid="model-preference-name"]').setValue('Web client');
        await wrapper.get('[data-testid="model-preference-save"]').trigger('click');
        await flushPromises();

        expect(queriesMock.updateModelPreference).toHaveBeenCalledWith('preference-1', {
            name: 'Web client',
            description: 'React and Vue work',
            model_id: 1,
        });
    });

    it('user keeps the dialog open and sees why a duplicate scenario was refused', async () => {
        queriesMock.createModelPreference.mockRejectedValue(
            new Error('A scenario named "Frontend" already exists')
        );
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        await wrapper.get('[data-testid="model-routing-add"]').trigger('click');
        await wrapper.get('[data-testid="model-preference-name"]').setValue('Frontend');
        await wrapper
            .get('[data-testid="model-preference-description"]')
            .setValue('Duplicate scenario');
        await wrapper.get('[data-testid="model-preference-save"]').trigger('click');
        await flushPromises();

        expect(alertMock.error).toHaveBeenCalledWith('A scenario named "Frontend" already exists');
        expect(wrapper.find('[data-testid="dialog-shell"]').exists()).toBe(true);
    });

    it('user deletes a scenario only after confirming', async () => {
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        await wrapper.get('[aria-label="Delete"]').trigger('click');
        await flushPromises();

        expect(confirmMock).toHaveBeenCalledWith({
            title: 'Delete scenario model',
            message: 'Delete "Frontend"?',
            type: 'danger',
        });
        expect(queriesMock.deleteModelPreference).toHaveBeenCalledWith('preference-1');
    });

    it('user keeps the scenario when the delete confirmation is cancelled', async () => {
        confirmMock.mockResolvedValue(false);
        const wrapper = mount(ModelPreferences);
        await flushPromises();

        await wrapper.get('[aria-label="Delete"]').trigger('click');
        await flushPromises();

        expect(queriesMock.deleteModelPreference).not.toHaveBeenCalled();
    });

    it('user sees model choices refreshed after providers or models change', async () => {
        mount(ModelPreferences);
        await flushPromises();
        expect(queriesMock.findModelsWithProvider).toHaveBeenCalledTimes(1);

        const handler = eventOnMock.mock.calls[0]?.[1] as () => Promise<void>;
        await handler();

        expect(queriesMock.findModelsWithProvider).toHaveBeenCalledTimes(2);
    });
});
