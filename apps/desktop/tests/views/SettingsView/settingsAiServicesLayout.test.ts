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

const llmMetadataMock = vi.hoisted(() => ({
    isLlmMetadataEmpty: vi.fn().mockResolvedValue(false),
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
    eventService: {
        emit: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@/services/AgentService', () => ({
    aiService: {
        createProviderInstance: vi.fn(() => ({
            listModels: vi.fn().mockResolvedValue([]),
            getApiTargets: () => ({ generationTarget: '' }),
        })),
    },
}));

vi.mock('@/services/AgentService/infrastructure/modelMetadata', () => ({
    updateModelMetadata: vi.fn().mockResolvedValue(undefined),
}));

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
        queries.findDefaultModel.mockResolvedValue(null);
        queries.findModelsWithProvider.mockResolvedValue([]);
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
                    ProviderList: true,
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
                    ProviderList: true,
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

    it('patches provider config locally without provider list reload', async () => {
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
        queries.findAllProvidersSorted.mockResolvedValue([provider]);

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
        expect(alertMock.success).toHaveBeenCalledWith('保存成功');
        expect(wrapper.text()).toContain('Renamed Gateway');
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
});
