import { findAllProvidersSorted } from '@database/queries/providers';
import type { ProviderEntity } from '@database/types';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

function getRequest(payload: InvokeArgs | undefined) {
    return (payload as { request?: { sql: string; method: string } })?.request;
}

function provider(overrides: Partial<ProviderEntity>): ProviderEntity {
    return {
        id: 1,
        name: 'Provider',
        driver: 'openai',
        api_endpoint: 'https://api.example.com',
        api_key: null,
        config_json: null,
        logo: '',
        enabled: 0,
        is_builtin: 1,
        created_at: '',
        updated_at: '',
        ...overrides,
    };
}

describe('provider database queries', () => {
    it('sorts enabled custom providers first, then builtin providers by display priority', async () => {
        const rows = [
            provider({ id: 1, name: 'Xiaomi MiMo', driver: 'mimo', enabled: 1 }),
            provider({ id: 2, name: 'DeepSeek', driver: 'deepseek', enabled: 1 }),
            provider({ id: 3, name: 'OpenAI', driver: 'openai', enabled: 1 }),
            provider({ id: 4, name: 'Custom Gateway', is_builtin: 0, enabled: 1 }),
            provider({ id: 5, name: 'Gemini', driver: 'google', enabled: 1 }),
            provider({ id: 6, name: 'Anthropic', driver: 'anthropic', enabled: 1 }),
            provider({ id: 7, name: 'Custom Disabled', is_builtin: 0, enabled: 0 }),
        ];

        interceptTauriInvoke((call) => {
            if (call.cmd !== 'database_query') {
                return undefined;
            }

            const request = getRequest(call.payload);
            if (request?.method !== 'all') {
                return undefined;
            }

            if (request.sql.includes('from "providers"')) {
                return { rows, rowsAffected: rows.length, lastInsertId: null };
            }

            if (request.sql.includes('from "models"')) {
                return { rows: [], rowsAffected: 0, lastInsertId: null };
            }

            return undefined;
        });

        await expect(findAllProvidersSorted()).resolves.toEqual([
            expect.objectContaining({ name: 'Custom Gateway' }),
            expect.objectContaining({ name: 'OpenAI' }),
            expect.objectContaining({ name: 'Anthropic' }),
            expect.objectContaining({ name: 'Gemini' }),
            expect.objectContaining({ name: 'Xiaomi MiMo' }),
            expect.objectContaining({ name: 'DeepSeek' }),
            expect.objectContaining({ name: 'Custom Disabled' }),
        ]);
    });
});
