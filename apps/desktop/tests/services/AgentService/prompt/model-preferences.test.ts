import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildModelPreferencesPrompt } from '@/services/AgentService/prompt/modelPreferences';

const queries = vi.hoisted(() => ({
    findModelRoleWithProvider: vi.fn(),
    listModelPreferences: vi.fn(),
}));

vi.mock('@database/queries', () => queries);

function createModel(overrides = {}) {
    return {
        id: 1,
        provider_id: 1,
        model_id: 'model-a',
        name: 'Model A',
        provider_name: 'Provider A',
        provider_enabled: 1,
        ...overrides,
    };
}

function createPreference(overrides = {}) {
    return {
        id: 1,
        name: '前端开发',
        description: 'React、Vue、CSS、Tailwind',
        provider_id: 1,
        model_id: 10,
        priority: 0,
        created_at: '',
        updated_at: '',
        model_name: 'Claude Sonnet',
        model_api_id: 'claude-sonnet',
        model_provider_id: 1,
        provider_name: 'Anthropic',
        provider_enabled: 1,
        ...overrides,
    };
}

describe('model preferences prompt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        queries.findModelRoleWithProvider.mockImplementation((role: string) => {
            if (role === 'entry') {
                return Promise.resolve(createModel({ name: 'Entry Model' }));
            }
            if (role === 'fast') {
                return Promise.resolve(createModel({ name: 'Fast Model' }));
            }
            if (role === 'general') {
                return Promise.resolve(createModel({ name: 'General Model' }));
            }
            return Promise.resolve(null);
        });
        queries.listModelPreferences.mockResolvedValue([createPreference()]);
    });

    it('injects model roles and usable scenario preferences', async () => {
        const [prompt] = await buildModelPreferencesPrompt();

        expect(prompt).toContain('## Model routing preferences');
        expect(prompt).toContain('Entry model');
        expect(prompt).toContain('Fast model');
        expect(prompt).toContain('General model');
        expect(prompt).toContain('Provider A / Entry Model');
        expect(prompt).toContain('Provider A / Fast Model');
        expect(prompt).toContain('Provider A / General Model');
        expect(prompt).toContain(
            '| 前端开发 | React、Vue、CSS、Tailwind | Anthropic / Claude Sonnet |'
        );
        expect(prompt).toContain('{ "scenario": "<Scenario>" }');
    });

    it('omits unusable scenario preferences without failing prompt construction', async () => {
        queries.listModelPreferences.mockResolvedValue([
            createPreference({ model_id: null }),
            createPreference({ name: '翻译', provider_enabled: 0 }),
        ]);

        const [prompt] = await buildModelPreferencesPrompt();

        expect(prompt).toContain(
            '| None configured | No custom scenario preferences are available. | - |'
        );
        expect(prompt).not.toContain('| 翻译 |');
    });

    it('escapes markdown table control characters in user-configured text', async () => {
        queries.listModelPreferences.mockResolvedValue([
            createPreference({
                name: 'Frontend | UI',
                description: 'React\\Vue\nCSS | Tailwind',
                provider_name: 'Provider\\A',
                model_name: 'Model | A',
            }),
        ]);

        const [prompt] = await buildModelPreferencesPrompt();

        expect(prompt).toContain(
            '| Frontend \\| UI | React\\\\Vue CSS \\| Tailwind | Provider\\\\A / Model \\| A |'
        );
    });

    it('falls back to an empty preference prompt when preference queries fail', async () => {
        queries.listModelPreferences.mockRejectedValue(new Error('database unavailable'));

        const [prompt] = await buildModelPreferencesPrompt();

        expect(prompt).toContain('## Model routing preferences');
        expect(prompt).toContain(
            '| None configured | No custom scenario preferences are available. | - |'
        );
    });
});
