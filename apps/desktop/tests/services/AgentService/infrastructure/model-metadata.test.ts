import { updateModelMetadata } from '@services/AgentService/infrastructure/modelMetadata';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function getRequest(payload: InvokeArgs | undefined) {
    return (payload as { request?: { sql: string; params?: unknown[]; method: string } })?.request;
}

describe('model metadata refresh', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('keeps prefix-distinct model ids when storing remote metadata', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                openai: {
                    models: {
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
                    },
                },
            }),
        })) as unknown as typeof fetch;

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

        await expect(updateModelMetadata()).resolves.toBeUndefined();

        const insertRequest = getTauriInvokeCalls('database_tx_query')
            .map((call) => getRequest(call.payload))
            .find((request) => request?.sql.includes('insert into "llm_metadata"'));

        expect(insertRequest?.params).toEqual(expect.arrayContaining(['gpt-4', 'gpt-4o']));
    });
});
