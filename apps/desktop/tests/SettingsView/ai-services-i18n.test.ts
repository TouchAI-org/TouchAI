import type { Model, Provider } from '@database/schema';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { createDomLocalizer } from '@/i18n/domLocalizer';
import AddProviderDialog from '@/views/SettingsView/components/AiServices/components/AddProviderDialog.vue';
import EditProviderDialog from '@/views/SettingsView/components/AiServices/components/EditProviderDialog.vue';
import ModelList from '@/views/SettingsView/components/AiServices/components/ModelList.vue';
import ProviderConfig from '@/views/SettingsView/components/AiServices/components/ProviderConfig.vue';
import ProviderList from '@/views/SettingsView/components/AiServices/components/ProviderList.vue';

const { alertErrorMock, alertWarningMock } = vi.hoisted(() => ({
    alertErrorMock: vi.fn(),
    alertWarningMock: vi.fn(),
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => ({
        error: alertErrorMock,
        warning: alertWarningMock,
    }),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/ModelLogo.vue', () => ({
    default: {
        name: 'ModelLogo',
        props: ['name'],
        template: '<span data-testid="model-logo">{{ name }}</span>',
    },
}));

vi.mock('@components/ModelCapabilityTags.vue', () => ({
    default: {
        name: 'ModelCapabilityTags',
        template: '<span data-testid="capability-tags" />',
    },
}));

vi.mock('@components/DialogShell.vue', () => ({
    default: {
        name: 'DialogShell',
        template: '<section data-testid="dialog-shell"><slot /></section>',
    },
}));

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options'],
        emits: ['update:modelValue'],
        template:
            '<select data-testid="custom-select"><option v-for="option in options" :key="option.value">{{ option.label }}</option></select>',
    },
}));

vi.mock('@components/PasswordInput.vue', () => ({
    default: {
        name: 'PasswordInput',
        props: ['modelValue', 'placeholder'],
        template: '<input data-testid="password-input" :placeholder="placeholder" />',
    },
}));

vi.mock('@components/ui/button', () => ({
    Button: {
        name: 'Button',
        props: ['variant'],
        template: '<button><slot /></button>',
    },
}));

vi.mock('@components/ui/input', () => ({
    Input: {
        name: 'Input',
        props: ['modelValue', 'placeholder'],
        emits: ['update:modelValue'],
        template:
            '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
    },
}));

vi.mock('@/views/SettingsView/components/AiServices/components/AddModelDialog.vue', () => ({
    default: {
        name: 'AddModelDialog',
        template: '<section data-testid="add-model-dialog" />',
    },
}));

vi.mock('@/views/SettingsView/components/AiServices/components/EditModelDialog.vue', () => ({
    default: {
        name: 'EditModelDialog',
        template: '<section data-testid="edit-model-dialog" />',
    },
}));

vi.mock('@/utils/modelSchemas', () => ({
    parseModelModalities: vi.fn(() => null),
}));

vi.mock('@/services/AgentService/infrastructure/modelMetadata', () => ({
    updateModelMetadata: vi.fn(),
}));

vi.mock('@/services/AgentService', () => ({
    aiService: {
        createProviderInstance: () => ({
            getApiTargets: () => ({
                generationTarget:
                    'https://very-long-provider.example.com/openai-compatible/v1/chat/completions',
            }),
        }),
    },
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => {
    const providerDriverDefinitions = [
        {
            driver: 'openai',
            label: 'OpenAI Compatible',
            logo: 'openai.svg',
            placeholder: 'https://api.openai.com/v1',
        },
    ];

    return {
        providerDriverDefinitions,
        getProviderDriverDefinitions: () => providerDriverDefinitions,
        getProviderDriverDefinition: () => providerDriverDefinitions[0],
        parseProviderConfigJson: (configJson: string | null) =>
            configJson ? JSON.parse(configJson) : {},
        isTouchAiManagedMode: (config: { touchAiMode?: 'managed' | 'custom' }, baseUrl: string) =>
            config.touchAiMode === 'custom'
                ? false
                : config.touchAiMode === 'managed'
                  ? true
                  : baseUrl === 'https://hub.touch-ai.org/api/v1',
    };
});

function createProvider(overrides: Partial<Provider> = {}): Provider {
    return {
        id: 1,
        name: 'Very Long Provider Name That Should Wrap Instead Of Squeezing Controls',
        driver: 'openai',
        api_endpoint: 'https://very-long-provider.example.com/openai-compatible/v1',
        api_key: '',
        config_json: null,
        logo: 'openai.svg',
        enabled: 1,
        is_builtin: 0,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        ...overrides,
    };
}

function createModel(overrides: Partial<Model> = {}): Model {
    return {
        id: 1,
        provider_id: 1,
        model_id: 'provider-family/extremely-long-model-name-with-many-segments-2026-preview',
        name: 'Extremely Long Model Name With Many Segments 2026 Preview',
        is_default: 0,
        last_used_at: null,
        attachment: 0,
        modalities: null,
        open_weights: 0,
        reasoning: 0,
        release_date: null,
        temperature: 1,
        tool_call: 1,
        knowledge: null,
        context_limit: null,
        output_limit: null,
        is_custom_metadata: 0,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        ...overrides,
    };
}

describe('AiServices i18n and layout', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
    });

    it('renders provider list chrome in English with wrapping-safe classes', () => {
        setLocale('en-US');

        const wrapper = mount(ProviderList, {
            props: {
                providers: [createProvider({ is_builtin: 1 })],
                selectedProviderId: 1,
            },
        });

        expect(wrapper.text()).toContain('Add custom provider');
        expect(wrapper.text()).toContain('Built-in');
        expect(wrapper.text()).not.toContain('大模型服务');

        const addButton = wrapper.get('button');
        expect(addButton.classes()).toContain('whitespace-normal');
        expect(addButton.classes()).toContain('break-words');
    });

    it('renders model list labels, placeholders, empty state, and refresh title in English', () => {
        setLocale('en-US');

        const wrapper = mount(ModelList, {
            props: {
                providerId: 1,
                models: [createModel()],
                entryModelId: null,
                provider: createProvider(),
                providerEnabled: true,
                refreshing: false,
            },
        });

        expect(wrapper.text()).toContain('Model list');
        expect(wrapper.get('input[type="text"]').attributes('placeholder')).toBe(
            'Search 1 model...'
        );
        expect(wrapper.find('button[title="Refresh model list from provider"]').exists()).toBe(
            true
        );
        expect(wrapper.text()).toContain('Add model');
        expect(wrapper.text()).not.toContain('模型列表');
    });

    it('localizes model refresh validation in English', () => {
        setLocale('en-US');

        const wrapper = mount(ModelList, {
            props: {
                providerId: 1,
                models: [],
                entryModelId: null,
                provider: createProvider({ api_endpoint: '' }),
                providerEnabled: true,
                refreshing: false,
            },
        });

        wrapper.get('button').trigger('click');

        expect(alertWarningMock).toHaveBeenCalledWith('Configure the API URL first');
    });

    it('renders add-provider dialog labels, validation, and preview in English', async () => {
        setLocale('en-US');

        const wrapper = mount(AddProviderDialog);

        expect(wrapper.text()).toContain('Add custom provider');
        expect(wrapper.text()).toContain('Provider name *');
        expect(wrapper.text()).toContain('Provider type *');
        expect(wrapper.get('input').attributes('placeholder')).toBe('My custom provider');

        await wrapper.findAll('button')[0]?.trigger('click');

        expect(alertErrorMock).toHaveBeenCalledWith('Enter provider name and request URL');
        expect(wrapper.text()).not.toContain('服务商名称');
    });

    it('renders edit-provider dialog labels, placeholder, validation, and preview in English', async () => {
        setLocale('en-US');

        const wrapper = mount(EditProviderDialog, {
            props: {
                provider: createProvider({ name: '   ' }),
            },
        });

        expect(wrapper.text()).toContain('Edit provider');
        expect(wrapper.text()).toContain('Provider name *');
        expect(wrapper.text()).toContain('Provider type *');
        expect(wrapper.text()).toContain('Base URL preview:');
        expect(wrapper.get('input').attributes('placeholder')).toBe('My custom provider');
        expect(wrapper.text()).toContain('Save');
        expect(wrapper.text()).toContain('Cancel');

        await wrapper.findAll('button')[0]?.trigger('click');

        expect(alertErrorMock).toHaveBeenCalledWith('Enter provider name');
        expect(wrapper.text()).not.toContain('编辑服务商');
        expect(wrapper.text()).not.toContain('我的自定义服务商');
    });

    it('renders provider configuration copy in English and allows long API previews to break', () => {
        setLocale('en-US');

        const wrapper = mount(ProviderConfig, {
            props: {
                provider: createProvider(),
            },
        });

        expect(wrapper.text()).toContain('Provider configuration');
        expect(wrapper.text()).toContain('Base URL preview:');
        expect(wrapper.find('p').classes()).toContain('break-all');
        expect(wrapper.text()).not.toContain('服务商配置');
    });

    it('does not let the global DOM localizer rewrite dynamic provider payload text', () => {
        setLocale('en-US');

        const wrapper = mount(ProviderList, {
            props: {
                providers: [createProvider({ name: '服务商', is_builtin: 1 })],
                selectedProviderId: 1,
            },
            attachTo: document.body,
        });

        const localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(wrapper.text()).toContain('Built-in');
        expect(wrapper.get('.provider-card h3').text()).toBe('服务商');
        expect(wrapper.get('.provider-card h3').attributes('data-no-i18n')).toBe('true');

        wrapper.unmount();
    });
});
