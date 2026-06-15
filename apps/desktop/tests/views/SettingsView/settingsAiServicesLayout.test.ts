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
        AI_MODELS_UPDATED: 'AI_MODELS_UPDATED',
    },
    eventService: eventServiceMock,
}));

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
}));

describe('SettingsAiServicesSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        agentServiceMock.createProviderInstance.mockReturnValue({
            listModels: vi.fn().mockResolvedValue([]),
            getApiTargets: () => ({ generationTarget: '' }),
        });
        queries.findDefaultModel.mockResolvedValue(null);
        queries.findModelsWithProvider.mockResolvedValue([]);
        modelMetadataMock.updateModelMetadata.mockResolvedValue(undefined);
    });

    it('omits custom-only controls for builtin providers', async () => {
        queries.findAllProvidersSorted.mockResolvedValue([
            {
                id: 1,
                name: '鐏北寮曟搸',
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

        expect(wrapper.text()).toContain('鐏北寮曟搸');
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

    it('patches the default model locally without provider list reload', async () => {
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
                        props: ['defaultModelId'],
                        emits: ['set-default'],
                        template: `
                            <button
                                data-testid="set-default-model"
                                @click="$emit('set-default', 20)"
                            >
                                default: {{ defaultModelId }}
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

        expect(wrapper.get('[data-testid="set-default-model"]').text()).toContain('default: 10');

        await wrapper.get('[data-testid="set-default-model"]').trigger('click');
        await flushPromises();

        expect(queries.setDefaultModel).toHaveBeenCalledWith({ modelId: 20 });
        expect(queries.findAllProvidersSorted).toHaveBeenCalledTimes(1);
        expect(alertMock.success).toHaveBeenCalledWith('设置成功');
        expect(wrapper.get('[data-testid="set-default-model"]').text()).toContain('default: 20');
    });
});
