import type { ModelWithProvider } from '@database/queries/models';
import type { ModelPreferenceWithModel } from '@database/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildModelPreferencesPrompt } from '@/services/AgentService/prompt/modelPreferences';

const { findModelRoleWithProviderMock, isModelRoutingEnabledMock, listModelPreferencesMock } =
    vi.hoisted(() => ({
        findModelRoleWithProviderMock: vi.fn(),
        isModelRoutingEnabledMock: vi.fn(),
        listModelPreferencesMock: vi.fn(),
    }));

vi.mock('@database/queries', () => ({
    findModelRoleWithProvider: findModelRoleWithProviderMock,
    isModelRoutingEnabled: isModelRoutingEnabledMock,
    listModelPreferences: listModelPreferencesMock,
}));

function createModel(overrides: Partial<ModelWithProvider>): ModelWithProvider {
    return {
        id: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        provider_id: 1,
        model_id: 'model-a',
        name: 'Model A',
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
        model_id: 2,
        priority: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        model_name: 'Frontend model',
        model_api_id: 'frontend-model',
        model_provider_id: 1,
        provider_name: 'Provider A',
        provider_enabled: 1,
        ...overrides,
    };
}

function promptText(fragments: string[]): string {
    return fragments.join('\n');
}

beforeEach(() => {
    vi.clearAllMocks();
    isModelRoutingEnabledMock.mockResolvedValue(true);
    listModelPreferencesMock.mockResolvedValue([]);
    findModelRoleWithProviderMock.mockResolvedValue(null);
});

describe('user works with model routing enabled', () => {
    it('user gets no routing instructions while the routing switch is off', async () => {
        isModelRoutingEnabledMock.mockResolvedValue(false);

        await expect(buildModelPreferencesPrompt()).resolves.toEqual([]);
        expect(listModelPreferencesMock).not.toHaveBeenCalled();
    });

    it('user sees the base model roles and configured scenarios described to the model', async () => {
        findModelRoleWithProviderMock.mockImplementation(async (role: string) => {
            if (role === 'entry') {
                return createModel({ id: 1, name: 'Entry model', model_id: 'entry-model' });
            }
            if (role === 'fast') {
                return createModel({
                    id: 2,
                    name: 'Fast model',
                    model_id: 'fast-model',
                    provider_name: 'Provider B',
                });
            }
            return null;
        });
        listModelPreferencesMock.mockResolvedValue([createPreference()]);

        const prompt = promptText(await buildModelPreferencesPrompt());

        expect(prompt).toContain('| Default model (entry) |');
        expect(prompt).toContain('Provider A / Entry model');
        expect(prompt).toContain('| Fast model (fast) |');
        expect(prompt).toContain('Provider B / Fast model');
        expect(prompt).toContain('| General model (general) |');
        expect(prompt).toContain('Provider A / Entry model');
        expect(prompt).toContain('| Frontend | React and Vue work | Provider A / Frontend model |');
        expect(prompt).toContain('`{ "scenario": "<Scenario>" }`');
    });

    it('user gets scenarios with a disabled provider or missing model left out', async () => {
        listModelPreferencesMock.mockResolvedValue([
            createPreference({ name: 'Usable' }),
            createPreference({
                id: 'preference-2',
                name: 'Disabled provider',
                provider_enabled: 0,
            }),
            createPreference({ id: 'preference-3', name: 'Missing model', model_id: null }),
            createPreference({ id: 'preference-4', name: '   ' }),
        ]);

        const prompt = promptText(await buildModelPreferencesPrompt());

        expect(prompt).toContain('| Usable |');
        expect(prompt).not.toContain('Disabled provider');
        expect(prompt).not.toContain('Missing model');
    });

    it('user sees table control characters escaped in scenario text', async () => {
        listModelPreferencesMock.mockResolvedValue([
            createPreference({
                name: 'Frontend | Backend',
                description: 'Line one\nLine two with C:\\tools',
                model_name: 'Model | One',
            }),
        ]);

        const prompt = promptText(await buildModelPreferencesPrompt());

        expect(prompt).toContain('| Frontend \\| Backend | Line one Line two with C:\\\\tools |');
        expect(prompt).toContain('Provider A / Model \\| One');
    });

    it('user still gets routing guidance when a preference lookup fails', async () => {
        listModelPreferencesMock.mockRejectedValue(new Error('database unavailable'));
        findModelRoleWithProviderMock.mockRejectedValue(new Error('database unavailable'));

        const prompt = promptText(await buildModelPreferencesPrompt());

        expect(prompt).toContain('## Model routing preferences');
        expect(prompt).toContain('| None configured |');
        expect(prompt).toContain('Not configured');
    });
});
