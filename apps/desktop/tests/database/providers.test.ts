import { findAllProvidersSorted } from '@database/queries/providers';
import { describe, expect, it } from 'vitest';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

describe('when the user opens the provider list', () => {
    it('user sees enabled custom providers first, then the builtin ones', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo, enabled, is_builtin)
            VALUES
                (1, 'Xiaomi MiMo', 'mimo', 'https://mimo.example/v1', '', 1, 1),
                (2, 'DeepSeek', 'deepseek', 'https://deepseek.example/v1', '', 1, 1),
                (3, 'OpenAI', 'openai', 'https://openai.example/v1', '', 1, 1),
                (4, 'Custom Gateway', 'openai-compatible', 'https://custom.example/v1', '', 1, 0),
                (5, 'Gemini', 'google', 'https://gemini.example/v1', '', 1, 1),
                (6, 'Anthropic', 'anthropic', 'https://anthropic.example/v1', '', 1, 1),
                (7, 'Custom Disabled', 'openai-compatible', 'https://off.example/v1', '', 0, 0);
        `);

        try {
            const providers = await findAllProvidersSorted();

            expect(providers.map((provider) => provider.name)).toEqual([
                'Custom Gateway',
                'OpenAI',
                'Anthropic',
                'Gemini',
                'Xiaomi MiMo',
                'DeepSeek',
                'Custom Disabled',
            ]);
        } finally {
            closeTestDatabases();
        }
    });
});
