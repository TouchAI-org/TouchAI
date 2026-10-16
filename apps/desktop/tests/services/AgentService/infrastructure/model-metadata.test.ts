import {
    seedModelMetadataFromSnapshot,
    updateModelMetadata,
} from '@services/AgentService/infrastructure/modelMetadata';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function getRequest(payload: InvokeArgs | undefined) {
    return (payload as { request?: { sql: string; params?: unknown[]; method: string } })?.request;
}

function mockMetadataTransaction() {
    interceptTauriInvoke((call) => {
        if (call.cmd === 'database_tx_begin') {
            return 'tx_model_metadata';
        }

        if (call.cmd === 'database_tx_commit' || call.cmd === 'database_tx_rollback') {
            return undefined;
        }

        if (call.cmd === 'database_tx_query') {
            const request = getRequest(call.payload);
            if (request?.sql.includes('insert into "statistics"')) {
                return {
                    rows: [{ key: 'model_metadata_last_updated_at' }],
                    rowsAffected: 1,
                    lastInsertId: 1,
                };
            }

            return { rows: [], rowsAffected: 1, lastInsertId: null };
        }

        return undefined;
    });
}

function executedTransactionSql(): string[] {
    return getTauriInvokeCalls('database_tx_query').map(
        (call) => getRequest(call.payload)?.sql ?? ''
    );
}

function findInsertRequest(table: string) {
    return getTauriInvokeCalls('database_tx_query')
        .map((call) => getRequest(call.payload))
        .find((request) => request?.sql.includes(`insert into "${table}"`));
}

function catalog(
    models: Record<string, Record<string, unknown>>,
    alias: Record<string, string> = {}
) {
    return { models, alias };
}

describe('model metadata refresh', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('stores one row per canonical model and keeps prefix-distinct ids apart', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () =>
                catalog({
                    'gpt-4': {
                        id: 'gpt-4',
                        name: 'GPT-4',
                        attachment: false,
                        open_weights: false,
                        reasoning: false,
                        temperature: true,
                        tool_call: true,
                    },
                    'gpt-4o': {
                        id: 'gpt-4o',
                        name: 'GPT-4o',
                        attachment: true,
                        open_weights: false,
                        reasoning: true,
                        temperature: true,
                        tool_call: true,
                    },
                }),
        })) as unknown as typeof fetch;

        mockMetadataTransaction();

        await expect(updateModelMetadata()).resolves.toBeUndefined();

        expect(findInsertRequest('llm_metadata')?.params).toEqual(
            expect.arrayContaining(['gpt-4', 'gpt-4o'])
        );
    });

    it('persists relay spellings in the alias table next to the model record', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () =>
                catalog(
                    {
                        'deepseek/deepseek-v4.1-flash': {
                            id: 'deepseek-flash',
                            name: 'DeepSeek V4.1 Flash',
                            reasoning: true,
                            reasoning_options: [
                                { type: 'toggle' },
                                { type: 'effort', values: ['low', 'high', 'max'] },
                            ],
                        },
                    },
                    {
                        'deepseek-flash': 'deepseek/deepseek-v4.1-flash',
                        'deepseek-v4.1-flash': 'deepseek/deepseek-v4.1-flash',
                    }
                ),
        })) as unknown as typeof fetch;

        mockMetadataTransaction();

        await expect(updateModelMetadata()).resolves.toBeUndefined();

        const aliasInsert = findInsertRequest('llm_metadata_aliases');
        expect(aliasInsert?.params).toEqual(
            expect.arrayContaining(['deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash'])
        );

        const sql = executedTransactionSql();
        expect(
            sql.some((statement) => statement.includes('delete from "llm_metadata_aliases"'))
        ).toBe(true);
    });

    it('applies refreshed metadata to runtime model rows in the same update', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () =>
                catalog(
                    {
                        'xiaomi/mimo-v2.5-pro': {
                            id: 'mimo-v2.5-pro',
                            name: 'MiMo v2.5 Pro',
                            attachment: true,
                            open_weights: false,
                            reasoning: true,
                            temperature: true,
                            tool_call: true,
                            modalities: {
                                input: ['text', 'image'],
                                output: ['text'],
                            },
                        },
                    },
                    { 'mimo-v2.5-pro': 'xiaomi/mimo-v2.5-pro' }
                ),
        })) as unknown as typeof fetch;

        mockMetadataTransaction();

        await expect(updateModelMetadata()).resolves.toBeUndefined();

        const updateRequest = getTauriInvokeCalls('database_tx_query')
            .map((call) => getRequest(call.payload))
            .find((request) => request?.sql.includes('UPDATE models'));

        expect(updateRequest?.sql).toContain('ranked_metadata');
        expect(updateRequest?.sql).toContain('llm_metadata_aliases');
    });

    it('rejects an empty remote catalog without clearing cached metadata', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => catalog({}),
        })) as unknown as typeof fetch;

        mockMetadataTransaction();

        await expect(updateModelMetadata()).rejects.toThrow(
            'Refusing to replace model metadata with an empty catalog'
        );

        const sql = executedTransactionSql();
        expect(sql.some((statement) => statement.includes('delete from "llm_metadata"'))).toBe(
            false
        );
        expect(sql.some((statement) => statement.includes('insert into "llm_metadata"'))).toBe(
            false
        );
        consoleSpy.mockRestore();
    });

    it('seeds bundled snapshot metadata without marking the cache as remotely updated', async () => {
        mockMetadataTransaction();

        await expect(seedModelMetadataFromSnapshot()).resolves.toBeUndefined();

        expect(findInsertRequest('llm_metadata')?.params).toEqual(
            expect.arrayContaining(['deepseek/deepseek-v4.1-flash'])
        );
        expect(findInsertRequest('llm_metadata_aliases')?.params).toEqual(
            expect.arrayContaining(['deepseek-v4.1-flash'])
        );

        const sql = executedTransactionSql();
        expect(sql.some((statement) => statement.includes('delete from "llm_metadata"'))).toBe(
            true
        );
        expect(sql.some((statement) => statement.includes('insert into "statistics"'))).toBe(false);
    });
});
