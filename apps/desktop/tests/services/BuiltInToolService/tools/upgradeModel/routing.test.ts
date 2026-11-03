import type { ModelWithProvider } from '@database/queries/models';
import type { ModelPreferenceWithModel } from '@database/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import {
    buildUpgradeModelApprovalRequest,
    executeUpgradeModelTool,
} from '@/services/BuiltInToolService/tools/upgradeModel';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';

const {
    findDefaultModelWithProviderMock,
    findEffectiveModelRoleWithProviderMock,
    findModelByIdWithProviderMock,
    findModelByProviderAndModelIdMock,
    findModelPreferenceByNameMock,
    isModelRoutingEnabledMock,
} = vi.hoisted(() => ({
    findDefaultModelWithProviderMock: vi.fn(),
    findEffectiveModelRoleWithProviderMock: vi.fn(),
    findModelByIdWithProviderMock: vi.fn(),
    findModelByProviderAndModelIdMock: vi.fn(),
    findModelPreferenceByNameMock: vi.fn(),
    isModelRoutingEnabledMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    findDefaultModelWithProvider: findDefaultModelWithProviderMock,
    findEffectiveModelRoleWithProvider: findEffectiveModelRoleWithProviderMock,
    findModelByIdWithProvider: findModelByIdWithProviderMock,
    findModelByProviderAndModelId: findModelByProviderAndModelIdMock,
    findModelPreferenceByName: findModelPreferenceByNameMock,
    isModelRoutingEnabled: isModelRoutingEnabledMock,
}));

function createModel(overrides: Partial<ModelWithProvider>): ModelWithProvider {
    return {
        id: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        provider_id: 1,
        model_id: 'entry-model',
        name: 'Entry model',
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

const entryModel = createModel({});
const fastModel = createModel({
    id: 2,
    provider_id: 2,
    provider_name: 'Provider B',
    model_id: 'fast-model',
    name: 'Fast model',
    is_default: 0,
});
const generalModel = createModel({
    id: 3,
    provider_id: 3,
    provider_name: 'Provider C',
    model_id: 'general-model',
    name: 'General model',
    is_default: 0,
});
const scenarioModel = createModel({
    id: 4,
    provider_id: 4,
    provider_name: 'Provider D',
    model_id: 'frontend-model',
    name: 'Frontend model',
    is_default: 0,
});
const targetModel = createModel({
    id: 5,
    provider_id: 5,
    provider_name: 'Provider E',
    model_id: 'target-model',
    name: 'Target model',
    is_default: 0,
});

const scenarioPreference: ModelPreferenceWithModel = {
    id: 'scenario-1',
    name: 'Frontend',
    description: 'React and Vue work',
    provider_id: 4,
    model_id: 4,
    priority: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    model_name: 'Frontend model',
    model_api_id: 'frontend-model',
    model_provider_id: 4,
    provider_name: 'Provider D',
    provider_enabled: 1,
};

function createContext(currentModel = entryModel): BaseBuiltInToolExecutionContext {
    return {
        callId: 'upgrade-call',
        iteration: 1,
        currentModel,
        hasExecutedBuiltInTool: vi.fn(() => false),
    };
}

function chainConfig() {
    return {
        chain: [
            { providerId: entryModel.provider_id, modelId: entryModel.model_id },
            { providerId: targetModel.provider_id, modelId: targetModel.model_id },
        ],
    };
}

function mockManualChain() {
    findModelByProviderAndModelIdMock.mockImplementation(
        async ({ providerId, modelId }: { providerId: number; modelId: string }) => {
            if (providerId === entryModel.provider_id && modelId === entryModel.model_id) {
                return entryModel;
            }
            if (providerId === targetModel.provider_id && modelId === targetModel.model_id) {
                return targetModel;
            }
            return undefined;
        }
    );
}

beforeEach(() => {
    setLocale('en-US');
    vi.clearAllMocks();
    isModelRoutingEnabledMock.mockResolvedValue(true);
    findDefaultModelWithProviderMock.mockResolvedValue(entryModel);
    findEffectiveModelRoleWithProviderMock.mockImplementation(async (role: string) => {
        if (role === 'entry') return entryModel;
        if (role === 'fast') return fastModel;
        if (role === 'general') return generalModel;
        return null;
    });
    findModelByIdWithProviderMock.mockResolvedValue(scenarioModel);
    findModelPreferenceByNameMock.mockResolvedValue(scenarioPreference);
    mockManualChain();
});

describe('user switches models manually', () => {
    it('user sees the upgrade chain approval and the switch signal without a selector', async () => {
        const approval = await buildUpgradeModelApprovalRequest(
            {},
            chainConfig(),
            'builtin:upgrade_model',
            createContext()
        );
        const result = await executeUpgradeModelTool({}, chainConfig(), createContext());

        expect(approval).toMatchObject({
            title: 'Confirm model switch',
            command: 'Provider A / Entry model -> Provider E / Target model',
        });
        expect(result.controlSignal).toMatchObject({
            type: 'upgrade_model',
            targetModel: targetModel,
        });
    });

    it('user keeps the manual upgrade chain and approval while routing is off', async () => {
        isModelRoutingEnabledMock.mockResolvedValue(false);

        const approval = await buildUpgradeModelApprovalRequest(
            {},
            chainConfig(),
            'builtin:upgrade_model',
            createContext()
        );
        const result = await executeUpgradeModelTool({}, chainConfig(), createContext());

        expect(approval).not.toBeNull();
        expect(result.controlSignal).toMatchObject({
            targetModel: targetModel,
        });
    });
});

describe('user lets the default model route a request', () => {
    it('user gets an immediate scenario switch without a manual approval card', async () => {
        const approval = await buildUpgradeModelApprovalRequest(
            { scenario: 'Frontend' },
            chainConfig(),
            'builtin:upgrade_model',
            createContext()
        );
        const result = await executeUpgradeModelTool(
            { scenario: 'Frontend' },
            chainConfig(),
            createContext()
        );

        expect(approval).toBeNull();
        expect(result).toMatchObject({
            isError: false,
            status: 'success',
            controlSignal: {
                type: 'upgrade_model',
                targetModel: scenarioModel,
            },
        });
        expect(result.result).toContain('Switched model for scenario: Frontend');
        expect(result.result).toContain('Provider D / Frontend model');
    });

    it('user gets the configured role model when the task matches that role', async () => {
        const result = await executeUpgradeModelTool(
            { role: 'fast' },
            chainConfig(),
            createContext()
        );

        expect(result).toMatchObject({
            isError: false,
            controlSignal: {
                targetModel: fastModel,
            },
        });
        expect(result.result).toContain('Switched model role: fast');
    });

    it('user gets the default model restored by reset or entry role', async () => {
        const restored = await executeUpgradeModelTool(
            { restore: true },
            chainConfig(),
            createContext(fastModel)
        );
        const entryRole = await executeUpgradeModelTool(
            { role: 'entry' },
            chainConfig(),
            createContext(generalModel)
        );

        expect(restored.controlSignal).toMatchObject({ targetModel: entryModel });
        expect(entryRole.controlSignal).toMatchObject({ targetModel: entryModel });
    });

    it('user gets a success without a redundant switch when already on the target', async () => {
        const result = await executeUpgradeModelTool(
            { role: 'entry' },
            chainConfig(),
            createContext(entryModel)
        );

        expect(result).toMatchObject({
            isError: false,
            status: 'success',
        });
        expect(result.controlSignal).toBeUndefined();
        expect(result.result).toContain('Model is already the target model');
    });
});

describe('user asks for an unusable routed model', () => {
    it('user gets a conflict error when more than one selector is supplied', async () => {
        const result = await executeUpgradeModelTool(
            { scenario: 'Frontend', role: 'fast' },
            chainConfig(),
            createContext()
        );

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.errorMessage).toBe('Specify only one model switch target at a time');
    });

    it('user gets routed selectors refused while routing is off', async () => {
        isModelRoutingEnabledMock.mockResolvedValue(false);

        const result = await executeUpgradeModelTool(
            { scenario: 'Frontend' },
            chainConfig(),
            createContext()
        );

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.errorMessage).toBe(
            'Model routing is disabled, so automatic model switching cannot run'
        );
    });

    it('user gets a clear error when the scenario no longer exists', async () => {
        findModelPreferenceByNameMock.mockResolvedValue(undefined);

        const result = await executeUpgradeModelTool(
            { scenario: 'Removed' },
            chainConfig(),
            createContext()
        );

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.errorMessage).toBe('Model scenario not found: Removed');
    });

    it('user gets a clear error when the scenario model is unavailable', async () => {
        findModelByIdWithProviderMock.mockResolvedValue({
            ...scenarioModel,
            provider_enabled: 0,
        });

        const result = await executeUpgradeModelTool(
            { scenario: 'Frontend' },
            chainConfig(),
            createContext()
        );

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.errorMessage).toBe('Model scenario target is unavailable: Frontend');
    });

    it('user gets a clear error when no default model is available to restore', async () => {
        findDefaultModelWithProviderMock.mockResolvedValue(null);

        const result = await executeUpgradeModelTool(
            { restore: true },
            chainConfig(),
            createContext(fastModel)
        );

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.errorMessage).toBe('Default model is unavailable');
    });
});
