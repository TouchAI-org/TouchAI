import {
    MODEL_METADATA_CHECK_INTERVAL_MS,
    refreshModelMetadataIfStale,
    seedModelMetadataFromSnapshot,
    shouldCheckModelMetadata,
    updateModelMetadata,
} from '@services/AgentService/infrastructure/modelMetadata';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '@/services/ObservabilityService';

const { metadataFetchMock } = vi.hoisted(() => ({
    metadataFetchMock: vi.fn(),
}));

vi.mock('@services/HttpService', () => ({
    createTauriFetch: () => metadataFetchMock,
    cancelResponseBody: vi.fn(async () => {}),
}));

/** 记录 statistics 表里写入的值，供断言 ETag 与检查时间。 */
const statistics = new Map<string, string>();

interface MockDatabaseOperation {
    kind: string;
    key?: string;
    checkedAt?: string;
    etag?: string | null;
    sourceEtag?: string | null;
    markUpdatedAt?: boolean;
    metadata?: Array<Record<string, unknown>>;
    aliases?: Array<Record<string, unknown>>;
}

function getDatabaseOperation(payload: InvokeArgs | undefined): MockDatabaseOperation | undefined {
    return (payload as { request?: MockDatabaseOperation })?.request;
}

function mockMetadataDatabase() {
    interceptTauriInvoke((call) => {
        if (call.cmd !== 'database_operation') {
            return undefined;
        }

        const operation = getDatabaseOperation(call.payload);
        switch (operation?.kind) {
            case 'statistic_get':
                return statistics.get(String(operation.key)) ?? null;
            case 'llm_metadata_replace':
                if (operation.markUpdatedAt) {
                    const now = new Date().toISOString();
                    statistics.set('model_metadata_last_updated_at', now);
                    statistics.set('model_metadata_last_checked_at', now);
                    if (operation.sourceEtag) {
                        statistics.set('model_metadata_source_etag', operation.sourceEtag);
                    }
                }
                return null;
            case 'llm_metadata_mark_checked':
                if (operation.checkedAt) {
                    statistics.set('model_metadata_last_checked_at', operation.checkedAt);
                }
                if (operation.etag) {
                    statistics.set('model_metadata_source_etag', operation.etag);
                }
                return null;
            default:
                return null;
        }
    });
}

function findOperation(kind: string): MockDatabaseOperation | undefined {
    return getTauriInvokeCalls('database_operation')
        .map((call) => getDatabaseOperation(call.payload))
        .find((operation) => operation?.kind === kind);
}

function catalog(
    models: Record<string, Record<string, unknown>>,
    alias: Record<string, string> = {}
) {
    return { models, alias };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
            get: (name: string) => headers[name.toLowerCase()] ?? null,
        },
        json: async () => body,
    } as unknown as Response;
}

describe('user sees model metadata refreshed from the catalog', () => {
    beforeEach(() => {
        statistics.clear();
        metadataFetchMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('user sees one row per canonical model with prefix-distinct ids kept apart', async () => {
        metadataFetchMock.mockResolvedValue(
            jsonResponse(
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
                })
            )
        );

        mockMetadataDatabase();

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'updated' });

        expect(findOperation('llm_metadata_replace')?.metadata?.map((row) => row.model_id)).toEqual(
            expect.arrayContaining(['gpt-4', 'gpt-4o'])
        );
    });

    it('user sees the relay spellings stored as aliases beside the model', async () => {
        metadataFetchMock.mockResolvedValue(
            jsonResponse(
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
                )
            )
        );

        mockMetadataDatabase();

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'updated' });

        const replace = findOperation('llm_metadata_replace');
        expect(replace?.aliases).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    alias: 'deepseek-v4.1-flash',
                    model_id: 'deepseek/deepseek-v4.1-flash',
                }),
            ])
        );
    });

    it('user sees model refresh and runtime row synchronization submitted as one replace', async () => {
        metadataFetchMock.mockResolvedValue(
            jsonResponse(
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
                            limit: {
                                context: 1000000,
                                output: 65536,
                            },
                        },
                    },
                    { 'mimo-v2.5-pro': 'xiaomi/mimo-v2.5-pro' }
                )
            )
        );

        mockMetadataDatabase();

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'updated' });

        const replace = findOperation('llm_metadata_replace');
        expect(replace?.metadata).toHaveLength(1);
        expect(replace?.metadata?.[0]).toMatchObject({
            model_id: 'xiaomi/mimo-v2.5-pro',
            attachment: 1,
            reasoning: 1,
            limit: '{"context":1000000,"output":65536}',
        });
        expect(replace?.markUpdatedAt).toBe(true);
    });

    it('user sees no rewrite when the catalog has not changed', async () => {
        statistics.set('model_metadata_source_etag', 'W/"v1"');
        metadataFetchMock.mockResolvedValue({
            ok: false,
            status: 304,
            statusText: 'Not Modified',
            headers: { get: () => null },
        } as unknown as Response);

        mockMetadataDatabase();

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'unchanged' });

        expect(metadataFetchMock).toHaveBeenCalledWith(
            expect.stringContaining('models.dev'),
            expect.objectContaining({
                headers: { 'If-None-Match': 'W/"v1"' },
            })
        );

        expect(findOperation('llm_metadata_replace')).toBeUndefined();
        expect(findOperation('llm_metadata_mark_checked')?.etag).toBe('W/"v1"');
        expect(statistics.get('model_metadata_last_checked_at')).toBeTruthy();
    });

    it('user sees the catalog change marker stored after a successful refresh', async () => {
        metadataFetchMock.mockResolvedValue(
            jsonResponse(
                catalog({
                    'gpt-4o': {
                        id: 'gpt-4o',
                        name: 'GPT-4o',
                        reasoning: true,
                    },
                }),
                { etag: 'W/"v2"' }
            )
        );

        mockMetadataDatabase();

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'updated' });

        expect(statistics.get('model_metadata_source_etag')).toBe('W/"v2"');
    });

    it('user keeps the cached metadata when the catalog comes back empty', async () => {
        const consoleSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
        metadataFetchMock.mockResolvedValue(jsonResponse(catalog({})));

        mockMetadataDatabase();

        await expect(updateModelMetadata()).rejects.toThrow(
            'Refusing to replace model metadata with an empty catalog'
        );

        expect(findOperation('llm_metadata_replace')).toBeUndefined();
        expect(findOperation('llm_metadata_mark_checked')).toBeUndefined();
        consoleSpy.mockRestore();
    });

    it('user sees the bundled snapshot seeded without marking it as remotely refreshed', async () => {
        mockMetadataDatabase();

        await expect(seedModelMetadataFromSnapshot()).resolves.toBeUndefined();

        const replace = findOperation('llm_metadata_replace');
        expect(replace?.metadata?.map((row) => row.model_id)).toEqual(
            expect.arrayContaining(['deepseek/deepseek-v4.1-flash'])
        );
        expect(replace?.aliases?.map((row) => row.alias)).toEqual(
            expect.arrayContaining(['deepseek-v4.1-flash'])
        );
        expect(replace?.markUpdatedAt).toBe(false);
        expect(findOperation('llm_metadata_mark_checked')).toBeUndefined();
    });

    it('user sees concurrent refreshes share a single catalog request', async () => {
        mockMetadataDatabase();
        metadataFetchMock.mockResolvedValue(
            jsonResponse(
                catalog({
                    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', reasoning: true },
                })
            )
        );

        const [first, second] = await Promise.all([
            refreshModelMetadataIfStale(),
            refreshModelMetadataIfStale(),
        ]);

        expect(first).toEqual({ status: 'updated' });
        expect(second).toEqual({ status: 'updated' });
        expect(metadataFetchMock).toHaveBeenCalledTimes(1);
    });

    it('user sees a later refresh allowed after a failed one', async () => {
        const consoleSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
        mockMetadataDatabase();
        metadataFetchMock.mockRejectedValueOnce(new Error('network down'));
        metadataFetchMock.mockResolvedValueOnce(
            jsonResponse(
                catalog({
                    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', reasoning: true },
                })
            )
        );

        await expect(refreshModelMetadataIfStale()).rejects.toThrow('network down');
        await expect(refreshModelMetadataIfStale()).resolves.toEqual({ status: 'updated' });
        expect(metadataFetchMock).toHaveBeenCalledTimes(2);
        consoleSpy.mockRestore();
    });

    it('user sees a missing or unreadable refresh timestamp treated as stale', async () => {
        mockMetadataDatabase();

        await expect(shouldCheckModelMetadata()).resolves.toBe(true);

        statistics.set('model_metadata_last_checked_at', 'not-a-date');
        await expect(shouldCheckModelMetadata()).resolves.toBe(true);
    });

    it('user sees no catalog request while the last refresh is fresh', async () => {
        statistics.set('model_metadata_last_checked_at', new Date().toISOString());

        mockMetadataDatabase();

        await expect(shouldCheckModelMetadata()).resolves.toBe(false);

        const result = await refreshModelMetadataIfStale();
        expect(result).toEqual({ status: 'skipped', reason: 'fresh' });
        expect(metadataFetchMock).not.toHaveBeenCalled();
    });

    it('user sees the catalog requested again once the refresh interval has passed', async () => {
        const staleTime = new Date(Date.now() - MODEL_METADATA_CHECK_INTERVAL_MS - 1000);
        statistics.set('model_metadata_last_checked_at', staleTime.toISOString());
        metadataFetchMock.mockResolvedValue(
            jsonResponse(
                catalog({
                    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', reasoning: true },
                })
            )
        );

        mockMetadataDatabase();

        await expect(refreshModelMetadataIfStale()).resolves.toEqual({ status: 'updated' });
        expect(metadataFetchMock).toHaveBeenCalledTimes(1);
    });
});
