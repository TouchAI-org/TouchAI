import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, vi } from 'vitest';

import AiServicesSection from '@/views/SettingsView/components/AiServices/index.vue';

const queries = vi.hoisted(() => ({
    createModel: vi.fn(),
    createModels: vi.fn(),
    createProvider: vi.fn(),
    deleteModel: vi.fn(),
    deleteProvider: vi.fn(),
    findAllProvidersSorted: vi.fn(),
    findDefaultModel: vi.fn(),
    findModelsWithProvider: vi.fn(),
    findProviderById: vi.fn(),
    setDefaultModel: vi.fn(),
    syncAllModelsMetadata: vi.fn(),
    updateModel: vi.fn(),
    updateProvider: vi.fn(),
}));

const alertMock = vi.hoisted(() => ({
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
}));

const eventServiceMock = vi.hoisted(() => ({
    emit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(async () => vi.fn()),
}));

const llmMetadataMock = vi.hoisted(() => ({
    isLlmMetadataEmpty: vi.fn().mockResolvedValue(false),
}));

const modelMetadataMock = vi.hoisted(() => ({
    updateModelMetadata: vi.fn().mockResolvedValue(undefined),
}));

const agentServiceMock = vi.hoisted(() => ({
    createProviderInstance: vi.fn(() => ({
        listModels: vi.fn().mockResolvedValue([]),
        getApiTargets: () => ({ generationTarget: '' }),
    })),
}));

const managedSettingsFocusMock = vi.hoisted(() => ({
    consumeManagedSettingsFocusRequest: vi.fn(),
    peekManagedSettingsFocusRequest: vi.fn(),
}));

vi.mock('@database', () => ({
    db: {
        transaction: vi.fn(async (callback: (tx: object) => Promise<void>) => callback({})),
    },
}));

vi.mock('@database/queries', () => queries);

vi.mock('@database/queries/llmMetadata.ts', () => llmMetadataMock);

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@composables/useAlert.ts', () => ({
    useAlert: () => alertMock,
}));

vi.mock('@composables/useContextMenu.ts', () => ({
    useContextMenu: () => ({ open: vi.fn() }),
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

vi.mock('@services/EventService', () => ({
    AppEvent: {
        SETTINGS_AI_SERVICES_FOCUS_PROVIDER: 'SETTINGS_AI_SERVICES_FOCUS_PROVIDER',
        AI_MODELS_UPDATED: 'AI_MODELS_UPDATED',
    },
    eventService: eventServiceMock,
}));

vi.mock('@services/AuthService/managedSettingsFocus', () => managedSettingsFocusMock);

vi.mock('@/services/AgentService', () => ({
    aiService: agentServiceMock,
}));

vi.mock('@/services/AgentService/infrastructure/modelMetadata', () => modelMetadataMock);

vi.mock('@/services/AgentService/infrastructure/providers', () => ({
    getProviderDriverDefinition: vi.fn(() => ({
        label: 'OpenAI',
        placeholder: 'https://api.example.com',
        logo: 'openai.png',
    })),
    parseProviderConfigJson: (configJson: string | null) =>
        configJson ? JSON.parse(configJson) : {},
    isTouchAiManagedMode: (config: { touchAiMode?: 'managed' | 'custom' }, baseUrl: string) =>
        config.touchAiMode === 'custom'
            ? false
            : config.touchAiMode === 'managed'
              ? true
              : baseUrl === 'https://hub.touch-ai.org/api/v1',
}));

describe('SettingsAiServicesSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        agentServiceMock.createProviderInstance.mockReturnValue({
            listModels: vi.fn().mockResolvedValue([]),
            getApiTargets: () => ({ generationTarget: '' }),
        });
        managedSettingsFocusMock.peekManagedSettingsFocusRequest.mockReturnValue(null);
        managedSettingsFocusMock.consumeManagedSettingsFocusRequest.mockReturnValue(null);
        queries.findDefaultModel.mockResolvedValue(null);
        queries.findModelsWithProvider.mockResolvedValue([]);
        modelMetadataMock.updateModelMetadata.mockResolvedValue(undefined);
    });

    it('omits custom-only controls for builtin providers', async () => {
        queries.findAllProvidersSorted.mockResolvedValue([
            {
                id: 1,
                name: '火山引擎',
                driver: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: null,
                config_json: null,
                logo: 'openai.png',
                enabled: 1,
                is_builtin: 1,
                created_at: '',
                updated_at: '',
            },
        ]);

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: {
                        emits: ['add-custom'],
                        template:
                            '<button data-testid="settings-add-custom-provider-button" @click="$emit(\'add-custom\')">add</button>',
                    },
                    ProviderConfig: true,
                    ModelList: true,
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name'],
                        template: '<div data-testid="badged-logo-stub" />',
                    },
                },
            },
        });

        await flushPromises();

        expect(wrapper.text()).toContain('火山引擎');
        expect(wrapper.find('[data-testid="settings-provider-driver-badge"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-provider-edit-button"]').exists()).toBe(false);
    });

    it('exposes custom provider controls and driver metadata', async () => {
        queries.findAllProvidersSorted.mockResolvedValue([
            {
                id: 2,
                name: 'Custom Gateway',
                driver: 'openai',
                api_endpoint: 'https://custom.example.com',
                api_key: 'sk-demo',
                config_json: null,
                logo: 'openai.png',
                enabled: 1,
                is_builtin: 0,
                created_at: '',
                updated_at: '',
            },
        ]);

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: {
                        emits: ['add-custom'],
                        template:
                            '<button data-testid="settings-add-custom-provider-button" @click="$emit(\'add-custom\')">add</button>',
                    },
                    ProviderConfig: true,
                    ModelList: true,
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name'],
                        template: '<div data-testid="badged-logo-stub" />',
                    },
                },
            },
        });

        await flushPromises();

        expect(wrapper.find('[data-testid="settings-provider-edit-button"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="settings-provider-driver-badge"]').text()).toBe('OpenAI');
        expect(wrapper.text()).toContain('Custom Gateway');
    });

    it('patches provider config locally and refreshes models without a success toast', async () => {
        const provider = {
            id: 2,
            name: 'Custom Gateway',
            driver: 'openai',
            api_endpoint: 'https://custom.example.com',
            api_key: 'sk-demo',
            config_json: null,
            logo: 'openai.png',
            enabled: 1,
            is_builtin: 0,
            created_at: '',
            updated_at: '',
        };
        const listModels = vi.fn().mockResolvedValue([
            {
                id: 'gpt-5-mini',
                name: 'GPT 5 Mini',
            },
        ]);
        queries.findAllProvidersSorted.mockResolvedValue([provider]);
        queries.findProviderById.mockResolvedValue({
            ...provider,
            name: 'Renamed Gateway',
        });
        agentServiceMock.createProviderInstance.mockReturnValue({
            listModels,
            getApiTargets: () => ({ generationTarget: '' }),
        });

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: true,
                    ProviderConfig: {
                        props: ['provider'],
                        emits: ['update'],
                        template: `
                            <button
                                data-testid="provider-config-update"
                                @click="$emit('update', { name: 'Renamed Gateway' })"
                            >
                                {{ provider.name }}
                            </button>
                        `,
                    },
                    ModelList: true,
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name'],
                        template: '<div data-testid="badged-logo-stub" />',
                    },
                },
            },
        });

        await flushPromises();

        expect(wrapper.text()).toContain('Custom Gateway');

        await wrapper.get('[data-testid="provider-config-update"]').trigger('click');
        await flushPromises();

        expect(queries.updateProvider).toHaveBeenCalledWith({
            id: 2,
            providerPatch: { name: 'Renamed Gateway' },
        });
        expect(queries.findAllProvidersSorted).toHaveBeenCalledTimes(1);
        expect(listModels).toHaveBeenCalled();
        expect(alertMock.success).not.toHaveBeenCalled();
        expect(wrapper.text()).toContain('Renamed Gateway');
    });

    it('refreshes models after creating a provider without a success toast', async () => {
        const createdProvider = {
            id: 9,
            name: 'New Gateway',
            driver: 'openai',
            api_endpoint: 'https://new.example.com',
            api_key: 'sk-new',
            config_json: null,
            logo: 'openai.png',
            enabled: 1,
            is_builtin: 0,
            created_at: '',
            updated_at: '',
        };
        const listModels = vi.fn().mockResolvedValue([
            {
                id: 'gpt-5-mini',
                name: 'GPT 5 Mini',
            },
        ]);
        queries.findAllProvidersSorted.mockResolvedValue([]);
        queries.createProvider.mockResolvedValue(createdProvider);
        queries.findProviderById.mockResolvedValue(createdProvider);
        agentServiceMock.createProviderInstance.mockReturnValue({
            listModels,
            getApiTargets: () => ({ generationTarget: '' }),
        });

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: {
                        emits: ['add-custom'],
                        template:
                            '<button data-testid="settings-add-custom-provider-button" @click="$emit(\'add-custom\')">add</button>',
                    },
                    ProviderConfig: true,
                    ModelList: true,
                    AddProviderDialog: {
                        emits: ['create', 'cancel'],
                        template: `
                            <button
                                data-testid="create-provider"
                                @click="$emit('create', {
                                    name: 'New Gateway',
                                    driver: 'openai',
                                    api_endpoint: 'https://new.example.com',
                                    api_key: 'sk-new',
                                    config_json: null,
                                    logo: 'openai.png',
                                    enabled: 1,
                                    is_builtin: 0
                                })"
                            >
                                create
                            </button>
                        `,
                    },
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name'],
                        template: '<div data-testid="badged-logo-stub" />',
                    },
                },
            },
        });

        await flushPromises();

        await wrapper.get('[data-testid="settings-add-custom-provider-button"]').trigger('click');
        await flushPromises();
        await wrapper.get('[data-testid="create-provider"]').trigger('click');
        await flushPromises();

        expect(queries.createProvider).toHaveBeenCalled();
        expect(listModels).toHaveBeenCalled();
        expect(alertMock.success).not.toHaveBeenCalled();
    });

    it('patches model edits locally without provider list reload', async () => {
        const provider = {
            id: 2,
            name: 'Custom Gateway',
            driver: 'openai',
            api_endpoint: 'https://custom.example.com',
            api_key: 'sk-demo',
            config_json: null,
            logo: 'openai.png',
            enabled: 1,
            is_builtin: 0,
            created_at: '',
            updated_at: '',
        };
        const currentDefaultModel = {
            id: 10,
            provider_id: 2,
            name: 'GPT 5 Mini',
            model_id: 'gpt-5-mini',
            is_default: 1,
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
            created_at: '',
            updated_at: '',
        };
        const nextDefaultModel = {
            ...currentDefaultModel,
            id: 20,
            name: 'GPT 5',
            model_id: 'gpt-5',
            is_default: 0,
        };
        queries.findAllProvidersSorted.mockResolvedValue([provider]);
        queries.findDefaultModel.mockResolvedValue(currentDefaultModel);
        queries.findModelsWithProvider.mockResolvedValue([currentDefaultModel, nextDefaultModel]);

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: true,
                    ProviderConfig: true,
                    ModelList: {
                        props: ['entryModelId'],
                        emits: ['update'],
                        template: `
                            <button
                                data-testid="update-model"
                                @click="$emit('update', 20, { name: 'Renamed Model' })"
                            >
                                entry: {{ entryModelId }}
                            </button>
                        `,
                    },
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name'],
                        template: '<div data-testid="badged-logo-stub" />',
                    },
                },
            },
        });

        await flushPromises();

        expect(wrapper.get('[data-testid="update-model"]').text()).toContain('entry: 10');

        await wrapper.get('[data-testid="update-model"]').trigger('click');
        await flushPromises();

        expect(queries.updateModel).toHaveBeenCalledWith({
            id: 20,
            modelPatch: { name: 'Renamed Model' },
        });
        expect(queries.findAllProvidersSorted).toHaveBeenCalledTimes(1);
        expect(alertMock.success).toHaveBeenCalledWith('保存成功');
    });

    it('renders builtin Xiaomi MiMo without a promoted badge', async () => {
        const provider = {
            id: 320,
            name: 'Xiaomi MiMo',
            driver: 'mimo',
            api_endpoint: 'https://hub.touch-ai.org/api/v1',
            api_key: 'tai-long-lived-key',
            config_json: JSON.stringify({
                touchAiMode: 'managed',
            }),
            logo: 'mimo.png',
            enabled: 1,
            is_builtin: 1,
            created_at: '',
            updated_at: '',
        };
        queries.findAllProvidersSorted.mockResolvedValue([provider]);
        queries.findProviderById.mockResolvedValue(provider);

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: {
                        props: ['providers'],
                        template: `
                            <div data-testid="provider-list-stub">
                                <span
                                    v-for="provider in providers"
                                    :key="provider.id"
                                    class="provider-name"
                                >
                                    {{ provider.name }}
                                </span>
                                <button data-testid="settings-add-custom-provider-button" />
                            </div>
                        `,
                    },
                    ProviderConfig: true,
                    ModelList: true,
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name', 'promoted'],
                        template:
                            '<div data-testid="badged-logo-stub" :data-promoted="String(promoted)" />',
                    },
                },
            },
        });

        await flushPromises();

        expect(wrapper.text()).toContain('Xiaomi MiMo');
        expect(wrapper.get('[data-testid="badged-logo-stub"]').attributes('data-promoted')).toBe(
            'false'
        );
    });

    it('keeps the full provider list visible when builtin Xiaomi MiMo is selected', async () => {
        const managedProvider = {
            id: 320,
            name: 'Xiaomi MiMo',
            driver: 'mimo',
            api_endpoint: 'https://hub.touch-ai.org/api/v1',
            api_key: null,
            config_json: JSON.stringify({
                touchAiMode: 'managed',
            }),
            logo: 'mimo.png',
            enabled: 1,
            is_builtin: 1,
            created_at: '',
            updated_at: '',
        };
        const customProvider = {
            id: 2,
            name: 'Custom Gateway',
            driver: 'openai',
            api_endpoint: 'https://custom.example.com',
            api_key: 'sk-demo',
            config_json: null,
            logo: 'openai.png',
            enabled: 1,
            is_builtin: 0,
            created_at: '',
            updated_at: '',
        };
        queries.findAllProvidersSorted.mockResolvedValue([managedProvider, customProvider]);

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: {
                        props: ['providers'],
                        template: `
                            <div data-testid="provider-list-stub">
                                <span
                                    v-for="provider in providers"
                                    :key="provider.id"
                                    class="provider-name"
                                >
                                    {{ provider.name }}
                                </span>
                                <button data-testid="settings-add-custom-provider-button" />
                            </div>
                        `,
                    },
                    ProviderConfig: true,
                    ModelList: true,
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name', 'promoted'],
                        template:
                            '<div data-testid="badged-logo-stub" :data-promoted="String(promoted)" />',
                    },
                },
            },
        });

        await flushPromises();

        expect(wrapper.text()).toContain('Xiaomi MiMo');
        expect(wrapper.text()).toContain('Custom Gateway');
        expect(wrapper.find('[data-testid="settings-add-custom-provider-button"]').exists()).toBe(
            true
        );
    });

    it('places builtin Xiaomi MiMo in the promoted provider section', async () => {
        const managedProvider = {
            id: 320,
            name: 'Xiaomi MiMo',
            driver: 'mimo',
            api_endpoint: 'https://hub.touch-ai.org/api/v1',
            api_key: null,
            config_json: JSON.stringify({
                touchAiMode: 'managed',
            }),
            logo: 'mimo.png',
            enabled: 1,
            is_builtin: 1,
            created_at: '',
            updated_at: '',
        };
        const openAiProvider = {
            id: 2,
            name: 'OpenAI',
            driver: 'openai',
            api_endpoint: 'https://api.openai.com',
            api_key: null,
            config_json: null,
            logo: 'openai.png',
            enabled: 1,
            is_builtin: 1,
            created_at: '',
            updated_at: '',
        };
        queries.findAllProvidersSorted.mockResolvedValue([openAiProvider, managedProvider]);

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: false,
                    ProviderConfig: true,
                    ModelList: true,
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name', 'promoted'],
                        template:
                            '<div data-testid="badged-logo-stub" :data-name="name" :data-promoted="String(promoted)" />',
                    },
                },
            },
        });

        await flushPromises();

        const badges = wrapper.findAll('[data-testid="badged-logo-stub"]');
        expect(badges[0]?.attributes('data-name')).toBe('Xiaomi MiMo');
        expect(badges[0]?.attributes('data-promoted')).toBe('true');
    });

    it('uses the configured long-lived activity api key when refreshing managed MiMo models', async () => {
        const provider = {
            id: 320,
            name: 'Xiaomi MiMo',
            driver: 'mimo',
            api_endpoint: 'https://hub.touch-ai.org/api/v1',
            api_key: 'tai-long-lived-key',
            config_json: JSON.stringify({
                touchAiMode: 'managed',
            }),
            logo: 'mimo.png',
            enabled: 1,
            is_builtin: 1,
            created_at: '',
            updated_at: '',
        };
        const listModels = vi.fn().mockResolvedValue([
            {
                id: 'mimo-v2.5',
                name: 'mimo-v2.5',
            },
        ]);
        queries.findAllProvidersSorted.mockResolvedValue([provider]);
        queries.findProviderById.mockResolvedValue(provider);
        agentServiceMock.createProviderInstance.mockReturnValue({
            listModels,
            getApiTargets: () => ({ generationTarget: '' }),
        });

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: true,
                    ProviderConfig: true,
                    ModelList: {
                        emits: ['refresh'],
                        template:
                            '<button data-testid="refresh-models" @click="$emit(\'refresh\')">refresh</button>',
                    },
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name'],
                        template: '<div data-testid="badged-logo-stub" />',
                    },
                },
            },
        });

        await flushPromises();
        await wrapper.get('[data-testid="refresh-models"]').trigger('click');
        await flushPromises();

        expect(agentServiceMock.createProviderInstance).toHaveBeenCalledWith(
            'mimo',
            'https://hub.touch-ai.org/api/v1',
            'tai-long-lived-key',
            JSON.stringify({
                touchAiMode: 'managed',
            })
        );
        expect(listModels).toHaveBeenCalled();
        expect(modelMetadataMock.updateModelMetadata).not.toHaveBeenCalled();
    });

    it('does not refresh managed MiMo models before login is completed', async () => {
        const provider = {
            id: 320,
            name: 'Xiaomi MiMo',
            driver: 'mimo',
            api_endpoint: 'https://hub.touch-ai.org/api/v1',
            api_key: null,
            config_json: JSON.stringify({
                touchAiMode: 'managed',
            }),
            logo: 'mimo.png',
            enabled: 1,
            is_builtin: 1,
            created_at: '',
            updated_at: '',
        };
        const listModels = vi.fn().mockResolvedValue([
            {
                id: 'mimo-v2.5',
                name: 'mimo-v2.5',
            },
        ]);
        queries.findAllProvidersSorted.mockResolvedValue([provider]);
        queries.findProviderById.mockResolvedValue(provider);
        agentServiceMock.createProviderInstance.mockReturnValue({
            listModels,
            getApiTargets: () => ({ generationTarget: '' }),
        });

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: true,
                    ProviderConfig: true,
                    ModelList: {
                        emits: ['refresh'],
                        template:
                            '<button data-testid="refresh-models" @click="$emit(\'refresh\')">refresh</button>',
                    },
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name'],
                        template: '<div data-testid="badged-logo-stub" />',
                    },
                },
            },
        });

        await flushPromises();
        await wrapper.get('[data-testid="refresh-models"]').trigger('click');
        await flushPromises();

        expect(agentServiceMock.createProviderInstance).not.toHaveBeenCalled();
        expect(listModels).not.toHaveBeenCalled();
        expect(alertMock.warning).toHaveBeenCalledWith('该服务商需要配置 API Key 才能获取模型列表');
    });

    it('focuses the builtin mimo provider in managed mode after auth callback navigation', async () => {
        const mimoProvider = {
            id: 320,
            name: 'Xiaomi MiMo',
            driver: 'mimo',
            api_endpoint: 'https://hub.touch-ai.org/api/v1',
            api_key: 'ta_live_abc',
            config_json: JSON.stringify({
                touchAiMode: 'custom',
                touchAiCustom: {
                    apiEndpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
                },
            }),
            logo: 'mimo.png',
            enabled: 1,
            is_builtin: 1,
            created_at: '',
            updated_at: '',
        };
        const managedModeProvider = {
            ...mimoProvider,
            config_json: JSON.stringify({
                touchAiMode: 'managed',
                touchAiCustom: {
                    apiEndpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
                },
            }),
        };
        const openAiProvider = {
            id: 2,
            name: 'OpenAI',
            driver: 'openai',
            api_endpoint: 'https://api.openai.com',
            api_key: null,
            config_json: null,
            logo: 'openai.png',
            enabled: 1,
            is_builtin: 1,
            created_at: '',
            updated_at: '',
        };
        const listModels = vi.fn().mockResolvedValue([
            {
                id: 'mimo-v2.5',
                name: 'mimo-v2.5',
            },
        ]);
        queries.findAllProvidersSorted.mockResolvedValue([openAiProvider, mimoProvider]);
        queries.findProviderById.mockResolvedValue(managedModeProvider);
        agentServiceMock.createProviderInstance.mockReturnValue({
            listModels,
            getApiTargets: () => ({ generationTarget: '' }),
        });
        managedSettingsFocusMock.peekManagedSettingsFocusRequest.mockReturnValue({
            section: 'ai-services',
            providerDriver: 'mimo',
            requireBuiltIn: true,
            mode: 'managed',
            reason: 'managed-auth-callback',
            requestedAt: 123,
        });

        const wrapper = mount(AiServicesSection, {
            global: {
                stubs: {
                    ProviderList: true,
                    ProviderConfig: {
                        props: ['provider'],
                        template:
                            '<div data-testid="provider-config-name">{{ provider.name }}</div>',
                    },
                    ModelList: true,
                    AddProviderDialog: true,
                    EditProviderDialog: true,
                    BadgedLogo: {
                        props: ['logo', 'name'],
                        template: '<div data-testid="badged-logo-stub" />',
                    },
                },
            },
        });

        await flushPromises();

        expect(wrapper.get('[data-testid="provider-config-name"]').text()).toBe('Xiaomi MiMo');
        expect(queries.updateProvider).toHaveBeenCalledWith({
            id: 320,
            providerPatch: {
                config_json: JSON.stringify({
                    touchAiMode: 'managed',
                    touchAiCustom: {
                        apiEndpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
                    },
                }),
            },
        });
        expect(managedSettingsFocusMock.consumeManagedSettingsFocusRequest).toHaveBeenCalled();
        expect(listModels).toHaveBeenCalled();
        expect(alertMock.success).not.toHaveBeenCalled();
    });
});
