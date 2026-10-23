import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type { AiModelsUpdatedEvent } from '@/services/EventService/types';
import AiServicesSection from '@/views/SettingsView/components/AiServices/index.vue';

const queries = vi.hoisted(() => ({
    createModel: vi.fn(),
    createProvider: vi.fn(),
    deleteModel: vi.fn(),
    deleteProvider: vi.fn(),
    findAllProvidersSorted: vi.fn(),
    findDefaultModel: vi.fn(),
    findModelsWithProvider: vi.fn(),
    findProviderById: vi.fn(),
    setDefaultModel: vi.fn(),
    updateModel: vi.fn(),
    updateProvider: vi.fn(),
}));

const alertMock = vi.hoisted(() => ({
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
}));

const scrollToDefaultModelMock = vi.hoisted(() => vi.fn());

const { eventServiceMock, modelUpdateListeners } = vi.hoisted(() => {
    const modelUpdateListeners = new Set<(payload: AiModelsUpdatedEvent) => void>();
    return {
        modelUpdateListeners,
        eventServiceMock: {
            emit: vi.fn(async (_event: string, payload: AiModelsUpdatedEvent) => {
                for (const listener of modelUpdateListeners) {
                    listener(payload);
                }
            }),
            on: vi.fn(async (_event: string, listener: (payload: AiModelsUpdatedEvent) => void) => {
                modelUpdateListeners.add(listener);
                return () => modelUpdateListeners.delete(listener);
            }),
        },
    };
});

const llmMetadataMock = vi.hoisted(() => ({
    isLlmMetadataAliasEmpty: vi.fn().mockResolvedValue(false),
    isLlmMetadataEmpty: vi.fn().mockResolvedValue(false),
}));

const modelMetadataMock = vi.hoisted(() => ({
    persistRefreshedModels: vi.fn().mockResolvedValue({ addedCount: 1 }),
    refreshModelMetadataIfStale: vi.fn().mockResolvedValue({ status: 'skipped' }),
    syncAllModelsMetadata: vi.fn().mockResolvedValue(undefined),
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

async function mountDefaultModelSelection(providerEnabled: number) {
    const provider = {
        id: 2,
        name: 'Custom Gateway',
        driver: 'openai',
        api_endpoint: 'https://custom.example.com',
        api_key: 'sk-demo',
        config_json: null,
        logo: 'openai.png',
        enabled: providerEnabled,
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
        provider_enabled: providerEnabled,
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
                ProviderList: {
                    props: ['providers', 'defaultModelProviderIds'],
                    template: `
                        <div data-testid="provider-state">
                            enabled: {{ providers[0]?.enabled }};
                            default: {{ defaultModelProviderIds.has(2) }}
                        </div>
                    `,
                },
                ProviderConfig: true,
                ModelList: {
                    props: ['defaultModelId', 'models'],
                    emits: ['set-default'],
                    methods: { scrollToDefaultModel: scrollToDefaultModelMock },
                    data: () => ({ searchQuery: '' }),
                    template: `
                        <div>
                            <input v-model="searchQuery" data-testid="model-filter" />
                            <button data-testid="set-default-model" @click="$emit('set-default', 20)">
                                default: {{ defaultModelId }}
                            </button>
                            <span v-for="model in models" :key="model.id" :data-testid="'model-' + model.id">
                                default: {{ model.is_default }}; enabled: {{ model.provider_enabled }}
                            </span>
                        </div>
                    `,
                },
                ProviderFormDialog: true,
                BadgedLogo: true,
            },
        },
    });
    await flushPromises();
    return wrapper;
}

describe('user manages providers and models', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        modelUpdateListeners.clear();
        setLocale('zh-CN');
        agentServiceMock.createProviderInstance.mockReturnValue({
            listModels: vi.fn().mockResolvedValue([]),
            getApiTargets: () => ({ generationTarget: '' }),
        });
        queries.findDefaultModel.mockResolvedValue(null);
        queries.findModelsWithProvider.mockResolvedValue([]);
        queries.updateProvider.mockReset().mockResolvedValue(undefined);
        queries.setDefaultModel.mockReset().mockResolvedValue(undefined);
        llmMetadataMock.isLlmMetadataAliasEmpty.mockResolvedValue(false);
        llmMetadataMock.isLlmMetadataEmpty.mockResolvedValue(false);
        modelMetadataMock.refreshModelMetadataIfStale.mockResolvedValue({ status: 'skipped' });
    });

    it('user omits custom-only controls for builtin providers', async () => {
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
                    ProviderFormDialog: true,
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

    it('user exposes custom provider controls and driver metadata', async () => {
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
                    ProviderFormDialog: true,
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

    it('user patches provider config locally and refreshes models without a success toast', async () => {
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
                    ProviderFormDialog: true,
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

    it('user refreshes models after creating a provider without a success toast', async () => {
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
                    ProviderFormDialog: {
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

    it('user hands the refreshed model list to the persistence use case', async () => {
        const upstreamCapabilities = {
            contextLimit: 400_000,
            outputLimit: 128_000,
            reasoning: true,
            reasoningOptions: [{ type: 'effort', values: ['low', 'max'] }],
        };
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
                id: 'group/auto-gpt-5-6-sol',
                name: 'group/auto-gpt-5-6-sol',
                capabilities: upstreamCapabilities,
            },
            { id: 'qianai/plain-model', name: 'qianai/plain-model' },
        ]);
        queries.findAllProvidersSorted.mockResolvedValue([]);
        queries.createProvider.mockResolvedValue(createdProvider);
        queries.findProviderById.mockResolvedValue(createdProvider);
        queries.findModelsWithProvider.mockResolvedValue([]);
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
                    ProviderFormDialog: {
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

        // 视图只把抓到的模型（领域形状）交给用例，落库顺序与列形状都在服务层。
        expect(modelMetadataMock.persistRefreshedModels).toHaveBeenCalledWith({
            providerId: 9,
            models: [
                {
                    id: 'group/auto-gpt-5-6-sol',
                    name: 'group/auto-gpt-5-6-sol',
                    capabilities: upstreamCapabilities,
                },
                { id: 'qianai/plain-model', name: 'qianai/plain-model' },
            ],
        });
        // 创建服务商后的自动刷新保持静默，成功提示留给手动刷新。
        expect(alertMock.success).not.toHaveBeenCalled();
    });

    it('user patches the default model locally without provider list reload', async () => {
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
                    ProviderFormDialog: true,
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

    it('user enables a disabled provider before setting its model as default and updates cached models', async () => {
        const wrapper = await mountDefaultModelSelection(0);

        await wrapper.get('[data-testid="set-default-model"]').trigger('click');
        await flushPromises();

        expect(queries.updateProvider).toHaveBeenCalledWith({
            id: 2,
            providerPatch: { enabled: 1 },
        });
        expect(queries.setDefaultModel).toHaveBeenCalledWith({ modelId: 20 });
        expect(queries.updateProvider.mock.invocationCallOrder[0]).toBeLessThan(
            queries.setDefaultModel.mock.invocationCallOrder[0]!
        );
        expect(wrapper.get('[data-testid="provider-state"]').text()).toContain('enabled: 1');
        expect(wrapper.get('[data-testid="set-default-model"]').text()).toContain('default: 20');
        expect(wrapper.get('[data-testid="model-10"]').text()).toContain('default: 0; enabled: 1');
        expect(wrapper.get('[data-testid="model-20"]').text()).toContain('default: 1; enabled: 1');
        expect(eventServiceMock.emit).toHaveBeenCalledTimes(1);
        expect(scrollToDefaultModelMock).toHaveBeenCalledWith(20);
        expect(queries.findAllProvidersSorted).toHaveBeenCalledTimes(1);
    });

    it('user preserves the model list and filter when its own update notification returns', async () => {
        const wrapper = await mountDefaultModelSelection(1);
        const filter = wrapper.get<HTMLInputElement>('[data-testid="model-filter"]');
        const scrollContainer = wrapper.get<HTMLElement>('.settings-scrollbar');
        await filter.setValue('gpt');
        scrollContainer.element.scrollTop = 320;

        await wrapper.get('[data-testid="set-default-model"]').trigger('click');
        await flushPromises();

        expect(wrapper.get('[data-testid="model-filter"]').element).toBe(filter.element);
        expect(filter.element.value).toBe('gpt');
        expect(scrollContainer.element.scrollTop).toBe(320);
        expect(wrapper.get('[data-testid="set-default-model"]').text()).toContain('default: 20');
        expect(queries.findAllProvidersSorted).toHaveBeenCalledTimes(1);
        expect(queries.findDefaultModel).toHaveBeenCalledTimes(1);
        expect(queries.findModelsWithProvider).toHaveBeenCalledTimes(1);
        expect(eventServiceMock.emit).toHaveBeenCalledTimes(1);
    });

    it('user sees local models while a remote metadata refresh is pending', async () => {
        let resolveRefresh!: (result: { status: string }) => void;
        modelMetadataMock.refreshModelMetadataIfStale.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRefresh = resolve;
            })
        );
        const wrapper = await mountDefaultModelSelection(1);

        try {
            expect(wrapper.find('[data-testid="set-default-model"]').exists()).toBe(true);
            expect(queries.findAllProvidersSorted).toHaveBeenCalledTimes(1);
            expect(queries.findModelsWithProvider).toHaveBeenCalledTimes(1);
        } finally {
            resolveRefresh({ status: 'skipped' });
            await flushPromises();
            wrapper.unmount();
        }
    });

    it('user still synchronizes model changes published by another instance', async () => {
        const wrapper = await mountDefaultModelSelection(1);
        queries.findDefaultModel.mockResolvedValue({ id: 20, provider_id: 2 });

        await eventServiceMock.emit('AI_MODELS_UPDATED', {
            sourceId: 'another-settings-instance',
            updatedAt: Date.now(),
        });
        await flushPromises();

        expect(queries.findAllProvidersSorted).toHaveBeenCalledTimes(2);
        expect(wrapper.get('[data-testid="set-default-model"]').text()).toContain('default: 20');
    });

    it('user keeps the previous default and disabled state when enabling fails', async () => {
        const wrapper = await mountDefaultModelSelection(0);
        queries.updateProvider.mockRejectedValueOnce(new Error('Enable failed'));

        await wrapper.get('[data-testid="set-default-model"]').trigger('click');
        await flushPromises();

        expect(queries.setDefaultModel).not.toHaveBeenCalled();
        expect(wrapper.get('[data-testid="provider-state"]').text()).toContain('enabled: 0');
        expect(wrapper.get('[data-testid="set-default-model"]').text()).toContain('default: 10');
        expect(eventServiceMock.emit).not.toHaveBeenCalled();
        expect(scrollToDefaultModelMock).not.toHaveBeenCalled();
        expect(alertMock.error).toHaveBeenCalledWith('Enable failed');
    });

    it('user keeps the previous default when saving a new default fails', async () => {
        const wrapper = await mountDefaultModelSelection(1);
        queries.setDefaultModel.mockRejectedValueOnce(new Error('Save failed'));

        await wrapper.get('[data-testid="set-default-model"]').trigger('click');
        await flushPromises();

        expect(queries.updateProvider).not.toHaveBeenCalled();
        expect(wrapper.get('[data-testid="set-default-model"]').text()).toContain('default: 10');
        expect(wrapper.get('[data-testid="model-10"]').text()).toContain('default: 1');
        expect(wrapper.get('[data-testid="model-20"]').text()).toContain('default: 0');
        expect(eventServiceMock.emit).not.toHaveBeenCalled();
        expect(scrollToDefaultModelMock).not.toHaveBeenCalled();
        expect(alertMock.error).toHaveBeenCalledWith('Save failed');
    });

    it('user sees the enabled provider state even when saving its default model fails', async () => {
        const wrapper = await mountDefaultModelSelection(0);
        queries.setDefaultModel.mockRejectedValueOnce(new Error('Save failed'));

        await wrapper.get('[data-testid="set-default-model"]').trigger('click');
        await flushPromises();

        expect(wrapper.get('[data-testid="provider-state"]').text()).toContain('enabled: 1');
        expect(wrapper.get('[data-testid="set-default-model"]').text()).toContain('default: 10');
        expect(wrapper.get('[data-testid="model-10"]').text()).toContain('default: 1; enabled: 1');
        expect(wrapper.get('[data-testid="model-20"]').text()).toContain('default: 0; enabled: 1');
        expect(eventServiceMock.emit).toHaveBeenCalledWith('AI_MODELS_UPDATED', {
            sourceId: expect.any(String),
            updatedAt: expect.any(Number),
        });
        expect(alertMock.error).toHaveBeenCalledWith('Save failed');
        expect(alertMock.success).not.toHaveBeenCalled();
    });
});
