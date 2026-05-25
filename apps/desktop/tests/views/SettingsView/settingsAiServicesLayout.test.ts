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
    useAlert: () => ({
        error: vi.fn(),
        success: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
    }),
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
});
