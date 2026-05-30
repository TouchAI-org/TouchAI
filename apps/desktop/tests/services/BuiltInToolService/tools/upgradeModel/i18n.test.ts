import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import {
    buildUpgradeModelApprovalRequest,
    executeUpgradeModelTool,
} from '@/services/BuiltInToolService/tools/upgradeModel';
import {
    normalizeUpgradeModelChain,
    normalizeUpgradeModelChainEntry,
} from '@/services/BuiltInToolService/tools/upgradeModel/chain';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';

const {
    findDefaultModelWithProviderMock,
    findEffectiveModelRoleWithProviderMock,
    findModelByIdWithProviderMock,
    findModelByProviderAndModelIdMock,
    findModelPreferenceByNameMock,
    getSettingValueMock,
} = vi.hoisted(() => ({
    findDefaultModelWithProviderMock: vi.fn(),
    findEffectiveModelRoleWithProviderMock: vi.fn(),
    findModelByIdWithProviderMock: vi.fn(),
    findModelByProviderAndModelIdMock: vi.fn(),
    findModelPreferenceByNameMock: vi.fn(),
    getSettingValueMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    findDefaultModelWithProvider: findDefaultModelWithProviderMock,
    findEffectiveModelRoleWithProvider: findEffectiveModelRoleWithProviderMock,
    findModelByIdWithProvider: findModelByIdWithProviderMock,
    findModelByProviderAndModelId: findModelByProviderAndModelIdMock,
    findModelPreferenceByName: findModelPreferenceByNameMock,
    getSettingValue: getSettingValueMock,
}));

function createModel(overrides: Partial<ModelWithProvider>): ModelWithProvider {
    return {
        id: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        provider_id: 1,
        model_id: 'model-a',
        name: 'Model A',
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
        provider_name: 'Provider',
        provider_driver: 'openai',
        api_endpoint: 'https://example.test',
        api_key: null,
        provider_config_json: null,
        provider_enabled: 1,
        provider_logo: '',
        ...overrides,
    };
}

function createContext(currentModel?: ModelWithProvider): BaseBuiltInToolExecutionContext {
    return {
        callId: 'upgrade-call',
        iteration: 1,
        currentModel,
        hasExecutedBuiltInTool: vi.fn(() => false),
    };
}

describe('UpgradeModel i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
        vi.clearAllMocks();
        getSettingValueMock.mockResolvedValue('false');
    });

    it('creates an English approval request for the resolved target model', async () => {
        setLocale('en-US');
        const currentModel = createModel({
            id: 10,
            provider_id: 1,
            model_id: 'model-a',
            name: 'Model A',
            provider_name: 'Provider A',
        });
        const targetModel = createModel({
            id: 20,
            provider_id: 2,
            model_id: 'model-b',
            name: 'Model B',
            provider_name: 'Provider B',
        });
        findModelByProviderAndModelIdMock
            .mockResolvedValueOnce(currentModel)
            .mockResolvedValueOnce(targetModel);

        const approval = await buildUpgradeModelApprovalRequest(
            {},
            {
                chain: [
                    { providerId: 1, modelId: 'model-a' },
                    { providerId: 2, modelId: 'model-b' },
                ],
            },
            'builtin:upgrade_model',
            createContext(currentModel)
        );

        expect(approval).toMatchObject({
            title: 'Confirm model switch',
            description: 'Allow switching from Provider A / Model A to Provider B / Model B',
            command: 'Provider A / Model A -> Provider B / Model B',
            reason: 'This changes the model used by the current conversation and also affects the subsequent default model.',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
        });
    });

    it('formats reachable execute result strings in English while returning the model switch signal', async () => {
        setLocale('en-US');
        const targetModel = createModel({
            id: 20,
            provider_id: 2,
            model_id: 'model-b',
            name: 'Model B',
            provider_name: 'Provider B',
        });
        findModelByProviderAndModelIdMock.mockResolvedValueOnce(targetModel);

        const result = await executeUpgradeModelTool(
            {},
            {
                chain: [{ providerId: 2, modelId: 'model-b' }],
            },
            createContext()
        );

        expect(result).toMatchObject({
            isError: false,
            status: 'success',
            controlSignal: {
                type: 'upgrade_model',
                targetModel,
                restartCurrentRequest: false,
            },
        });
        expect(result.result).toContain('Model upgraded');
        expect(result.result).toContain('Target model: Provider B / Model B');
        expect(result.result).toContain(
            'The system will switch directly to the new model and continue the conversation with the current context.'
        );
    });

    it('formats reachable error result strings in English when no target is available', async () => {
        setLocale('en-US');

        const result = await executeUpgradeModelTool({}, { chain: [] }, createContext());

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage: 'Configure the model upgrade chain in UpgradeModel settings first.',
        });
        expect(result.result).toContain('Model upgrade failed');
        expect(result.result).toContain('Current model: Unknown');
        expect(result.result).toContain('Upgrade chain: Not configured');
        expect(result.result).toContain(
            'Reason: Configure the model upgrade chain in UpgradeModel settings first.'
        );
    });

    it('formats upgrade chain validation errors in English', () => {
        setLocale('en-US');

        expect(() =>
            normalizeUpgradeModelChainEntry({
                providerId: 1,
                modelId: '',
            })
        ).toThrow('Each model upgrade chain item must include providerId and a non-empty modelId.');
        expect(() => normalizeUpgradeModelChain('not-json')).toThrow(
            'The model upgrade chain must be an array or a JSON string that parses to an array.'
        );
        expect(() => normalizeUpgradeModelChain('{"providerId":1,"modelId":"model-a"}')).toThrow(
            'The model upgrade chain must be an array or a JSON string that parses to an array.'
        );
        expect(() => normalizeUpgradeModelChain({ providerId: 1, modelId: 'model-a' })).toThrow(
            'The model upgrade chain must be an array or a JSON string that parses to an array.'
        );
        expect(() => normalizeUpgradeModelChain([{ providerId: 1, modelId: '' }])).toThrow(
            'Each model upgrade chain item must include providerId and a non-empty modelId.'
        );
    });

    it('switches to a configured scenario model without exposing provider details to the model', async () => {
        setLocale('en-US');
        const targetModel = createModel({
            id: 20,
            provider_id: 2,
            model_id: 'claude-sonnet',
            name: 'Claude Sonnet',
            provider_name: 'Anthropic',
        });
        findModelPreferenceByNameMock.mockResolvedValue({
            id: 1,
            name: 'Frontend',
            description: 'React and CSS work',
            model_id: 20,
        });
        findModelByIdWithProviderMock.mockResolvedValue(targetModel);

        const result = await executeUpgradeModelTool(
            { scenario: 'Frontend' },
            { chain: [] },
            createContext(createModel({ id: 10 }))
        );

        expect(findModelPreferenceByNameMock).toHaveBeenCalledWith('Frontend');
        expect(result).toMatchObject({
            isError: false,
            status: 'success',
            controlSignal: {
                type: 'upgrade_model',
                targetModel,
                restartCurrentRequest: false,
            },
        });
        expect(result.result).toContain('Switched model for scenario: Frontend');
        expect(result.result).toContain('Target model: Anthropic / Claude Sonnet');
    });

    it('does not request approval or emit a switch signal when the target is the current model', async () => {
        setLocale('en-US');
        const currentModel = createModel({
            id: 20,
            provider_id: 2,
            model_id: 'claude-sonnet',
            name: 'Claude Sonnet',
            provider_name: 'Anthropic',
        });
        findModelPreferenceByNameMock.mockResolvedValue({
            id: 1,
            name: 'Frontend',
            description: 'React and CSS work',
            model_id: 20,
        });
        findModelByIdWithProviderMock.mockResolvedValue(currentModel);

        const approval = await buildUpgradeModelApprovalRequest(
            { scenario: 'Frontend' },
            { chain: [] },
            'builtin:upgrade_model',
            createContext(currentModel)
        );
        const result = await executeUpgradeModelTool(
            { scenario: 'Frontend' },
            { chain: [] },
            createContext(currentModel)
        );

        expect(approval).toBeNull();
        expect(result).toMatchObject({
            isError: false,
            status: 'success',
        });
        expect(result.controlSignal).toBeUndefined();
        expect(result.result).toContain('Model is already the target model');
    });

    it('skips approval when automatic model switching is enabled', async () => {
        setLocale('en-US');
        getSettingValueMock.mockResolvedValueOnce('true');
        const currentModel = createModel({
            id: 10,
            provider_id: 1,
            model_id: 'model-a',
            name: 'Model A',
            provider_name: 'Provider A',
        });
        const targetModel = createModel({
            id: 20,
            provider_id: 2,
            model_id: 'model-b',
            name: 'Model B',
            provider_name: 'Provider B',
        });
        findModelByProviderAndModelIdMock
            .mockResolvedValueOnce(currentModel)
            .mockResolvedValueOnce(targetModel);

        const approval = await buildUpgradeModelApprovalRequest(
            {},
            {
                chain: [
                    { providerId: 1, modelId: 'model-a' },
                    { providerId: 2, modelId: 'model-b' },
                ],
            },
            'builtin:upgrade_model',
            createContext(currentModel)
        );

        expect(approval).toBeNull();
    });

    it('rejects conflicting model switch target selectors', async () => {
        setLocale('en-US');

        const result = await executeUpgradeModelTool(
            { role: 'fast', scenario: 'Frontend' },
            { chain: [] },
            createContext()
        );

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage: 'Specify only one model switch target at a time',
        });
        expect(findEffectiveModelRoleWithProviderMock).not.toHaveBeenCalled();
        expect(findModelPreferenceByNameMock).not.toHaveBeenCalled();
    });
});
