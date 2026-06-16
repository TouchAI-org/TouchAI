import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';

import { setLocale } from '@/i18n';
import AiServicesView from '@/views/SettingsView/components/AiServices/index.vue';

const { capturedContextMenus } = vi.hoisted(() => ({
    capturedContextMenus: [] as Array<Array<{ key: string; label: string }>>,
}));

vi.mock('@composables/useContextMenu.ts', () => ({
    useContextMenu: (items: Array<{ key: string; label: string }>) => {
        capturedContextMenus.push(items);
        return {
            open: vi.fn(),
        };
    },
}));

vi.mock('@composables/useAlert.ts', () => ({
    useAlert: () => ({
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
    }),
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: defineComponent({
        name: 'AppIcon',
        template: '<span data-testid="app-icon" />',
    }),
}));

vi.mock('@database', () => ({
    db: {
        transaction: vi.fn(),
    },
}));

vi.mock('@database/queries', () => ({
    createModel: vi.fn(),
    createModels: vi.fn(),
    createProvider: vi.fn(),
    deleteModel: vi.fn(),
    deleteProvider: vi.fn(),
    findAllProvidersSorted: vi.fn(async () => []),
    findDefaultModel: vi.fn(async () => null),
    findModelsWithProvider: vi.fn(async () => []),
    findProviderById: vi.fn(async () => null),
    getSettingValue: vi.fn(async () => null),
    listModelPreferences: vi.fn(async () => []),
    setDefaultModel: vi.fn(),
    syncAllModelsMetadata: vi.fn(),
    updateModel: vi.fn(),
    updateProvider: vi.fn(),
}));

vi.mock('@/database/queries/llmMetadata.ts', () => ({
    isLlmMetadataEmpty: vi.fn(async () => false),
}));

vi.mock('@services/EventService', () => ({
    AppEvent: {
        AI_MODELS_UPDATED: 'ai-models-updated',
    },
    eventService: {
        emit: vi.fn(),
        on: vi.fn(async () => vi.fn()),
    },
}));

vi.mock('@/services/AgentService', () => ({
    aiService: {
        createProviderInstance: () => ({
            listModels: vi.fn(async () => []),
            getApiTargets: () => ({
                generationTarget: '',
            }),
        }),
    },
}));

vi.mock('@/services/AgentService/infrastructure/modelMetadata', () => ({
    updateModelMetadata: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => ({
    getProviderDriverDefinition: () => ({
        driver: 'openai',
        label: 'OpenAI',
        logo: 'openai.png',
        placeholder: 'https://api.openai.com',
    }),
    parseProviderConfigJson: (configJson: string | null) =>
        configJson ? JSON.parse(configJson) : {},
}));

vi.mock('@/views/SettingsView/components/AiServices/components/ProviderList.vue', () => ({
    default: defineComponent({
        name: 'ProviderList',
        template: '<section data-testid="provider-list" />',
    }),
}));

vi.mock('@/views/SettingsView/components/AiServices/components/ProviderConfig.vue', () => ({
    default: defineComponent({
        name: 'ProviderConfig',
        template: '<section data-testid="provider-config" />',
    }),
}));

vi.mock('@/views/SettingsView/components/AiServices/components/ModelList.vue', () => ({
    default: defineComponent({
        name: 'ModelList',
        template: '<section data-testid="model-list" />',
    }),
}));

vi.mock('@/views/SettingsView/components/AiServices/components/AddProviderDialog.vue', () => ({
    default: defineComponent({
        name: 'AddProviderDialog',
        template: '<section data-testid="add-provider-dialog" />',
    }),
}));

vi.mock('@/views/SettingsView/components/AiServices/components/EditProviderDialog.vue', () => ({
    default: defineComponent({
        name: 'EditProviderDialog',
        template: '<section data-testid="edit-provider-dialog" />',
    }),
}));

vi.mock('@/views/SettingsView/components/AiServices/components/AddModelDialog.vue', () => ({
    default: defineComponent({
        name: 'AddModelDialog',
        template: '<section data-testid="add-model-dialog" />',
    }),
}));

vi.mock('@/views/SettingsView/components/AiServices/components/EditModelDialog.vue', () => ({
    default: defineComponent({
        name: 'EditModelDialog',
        template: '<section data-testid="edit-model-dialog" />',
    }),
}));

describe('AiServices section i18n', () => {
    beforeEach(() => {
        capturedContextMenus.length = 0;
        setLocale('zh-CN');
    });

    it('refreshes provider context menu labels after runtime locale changes', async () => {
        mount(AiServicesView);

        expect(capturedContextMenus[0]?.map((item) => item.label)).toEqual(['编辑', '删除']);

        setLocale('en-US');
        await nextTick();

        expect(capturedContextMenus[0]?.map((item) => item.label)).toEqual(['Edit', 'Delete']);
    });
});
