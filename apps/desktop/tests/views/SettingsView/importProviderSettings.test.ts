import { describe, expect, it, vi } from 'vitest';

import type { ProviderImportCandidate } from '@/app/api/models/providerSettingsImport';
import {
    createProviderImportEntries,
    importProviderSettings,
} from '@/views/SettingsView/components/AiServices/importProviderSettings';

function candidate(overrides: Partial<ProviderImportCandidate> = {}): ProviderImportCandidate {
    return {
        providerName: 'Imported gateway',
        driver: 'anthropic-compatible',
        apiEndpoint: 'https://gateway.example.test/v1',
        modelId: 'claude-sonnet-4-5',
        apiKey: 'test-only-key',
        ...overrides,
    };
}

describe('user confirms compatible provider settings', () => {
    it('user gets an enabled provider and model when the imported key is present', async () => {
        const importProviders = vi.fn().mockResolvedValue([]);

        await importProviderSettings([candidate()], importProviders);

        expect(importProviders).toHaveBeenCalledWith({
            entries: [
                {
                    provider: {
                        name: 'Imported gateway',
                        driver: 'anthropic-compatible',
                        api_endpoint: 'https://gateway.example.test/v1',
                        api_key: 'test-only-key',
                        logo: 'anthropic.png',
                        enabled: 1,
                        is_builtin: 0,
                    },
                    model: {
                        name: 'claude-sonnet-4-5',
                        model_id: 'claude-sonnet-4-5',
                    },
                },
            ],
        });
    });

    it('user gets a disabled provider without a model when those fields need manual setup', () => {
        expect(
            createProviderImportEntries([candidate({ apiKey: null, modelId: null })])[0]
        ).toMatchObject({
            provider: { enabled: 0, api_key: null },
            model: null,
        });
    });
});
