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

const { metadataFetchMock } = vi.hoisted(() => ({
    metadataFetchMock: vi.fn(),
}));

vi.mock('@services/AgentService/infrastructure/providers', () => ({
    createTauriFetch: () => metadataFetchMock,
}));

function getRequest(payload: InvokeArgs | undefined) {
    return (payload as { request?: { sql: string; params?: unknown[]; method: string } })?.request;
}

/** 记录 statistics 表里写入的值，供断言 ETag 与检查时间。 */
const statistics = new Map<string, string>();

interface MockSyncRows {
    models?: unknown[];
    aliases?: unknown[];
    metadata?: unknown[];
}

/** 按表返回 sync 读取的行；未声明的表返回空集。 */
function resolveSyncRows(sql: string, syncRows: MockSyncRows) {
    if (sql.includes('"llm_metadata_aliases"')) {
        return syncRows.aliases ?? [];
    }

    if (sql.includes('"llm_metadata"')) {
        return syncRows.metadata ?? [];
    }

    if (sql.includes('from "models"')) {
        return syncRows.models ?? [];
    }

    return [];
}

function mockMetadataTransaction(syncRows: MockSyncRows = {}) {
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
                const [key, value] = request.params ?? [];
                statistics.set(String(key), String(value));

                return {
                    rows: [{ key }],
                    rowsAffected: 1,
                    lastInsertId: 1,
                };
            }

            if (request?.method === 'all') {
                return {
                    rows: resolveSyncRows(request.sql, syncRows),
                    rowsAffected: 0,
                    lastInsertId: null,
                };
            }

            return { rows: [], rowsAffected: 1, lastInsertId: null };
        }

        if (call.cmd === 'database_query') {
            const request = getRequest(call.payload);

            // 命中 304 时只推进检查时间，这条写入不经过事务。
            if (request?.sql.includes('insert into "statistics"')) {
                const [key, value] = request.params ?? [];
                statistics.set(String(key), String(value));

                return {
                    rows: [{ key }],
                    rowsAffected: 1,
                    lastInsertId: 1,
                };
            }

            const key = String(request?.params?.[0] ?? '');
            const value = statistics.get(key);

            return {
                rows: value ? [{ id: 1, key, value, created_at: '', updated_at: '' }] : [],
                rowsAffected: 0,
                lastInsertId: null,
            };
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

/**
 * 收集某张表所有 insert 语句的参数。
 *
 * 批量写入会按参数个数上限分批（见 `replaceModelMetadata`），
 * 所以断言“某个值被写入”时必须跨批次收集，而不是只看第一条。
 */
function collectInsertParams(table: string): unknown[] {
    return getTauriInvokeCalls('database_tx_query')
        .map((call) => getRequest(call.payload))
        .filter((request) => request?.sql.includes(`insert into "${table}"`))
        .flatMap((request) => request?.params ?? []);
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

describe('model metadata refresh', () => {
    beforeEach(() => {
        statistics.clear();
        metadataFetchMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('stores one row per canonical model and keeps prefix-distinct ids apart', async () => {
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

        mockMetadataTransaction();

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'updated' });

        expect(findInsertRequest('llm_metadata')?.params).toEqual(
            expect.arrayContaining(['gpt-4', 'gpt-4o'])
        );
    });

    it('persists relay spellings in the alias table next to the model record', async () => {
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

        mockMetadataTransaction();

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'updated' });

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
                        },
                    },
                    { 'mimo-v2.5-pro': 'xiaomi/mimo-v2.5-pro' }
                )
            )
        );

        mockMetadataTransaction({
            models: [{ id: 7, model_id: 'mimo-v2.5-pro' }],
            aliases: [{ alias: 'mimo-v2.5-pro', model_id: 'xiaomi/mimo-v2.5-pro' }],
            metadata: [
                {
                    model_id: 'xiaomi/mimo-v2.5-pro',
                    attachment: 1,
                    modalities: '{"input":["text","image"],"output":["text"]}',
                    open_weights: 0,
                    reasoning: 1,
                    reasoning_options: null,
                    release_date: null,
                    temperature: 1,
                    tool_call: 1,
                    knowledge: null,
                    limit: '{"context":1000000,"output":65536}',
                },
            ],
        });

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'updated' });

        const requests = getTauriInvokeCalls('database_tx_query').map((call) =>
            getRequest(call.payload)
        );

        // 候选只用于批量读取；匹配在应用层完成后只剩一条 UPDATE。
        expect(
            requests.some(
                (request) => request?.method === 'all' && request.sql.includes('json_each(')
            )
        ).toBe(true);

        const updateRequest = requests.find((request) => request?.sql.includes('UPDATE models'));
        expect(updateRequest?.sql).toContain('selected_model_metadata');
        expect(updateRequest?.sql).not.toContain('llm_metadata_aliases');

        const payload = JSON.parse(String(updateRequest?.params?.[0]));
        expect(payload).toHaveLength(1);
        expect(payload[0]).toMatchObject({
            id: 7,
            attachment: 1,
            reasoning: 1,
            context_limit: 1000000,
            output_limit: 65536,
        });
    });

    it('sends the stored ETag and skips rewriting when the source is unchanged', async () => {
        statistics.set('model_metadata_source_etag', 'W/"v1"');
        metadataFetchMock.mockResolvedValue({
            ok: false,
            status: 304,
            statusText: 'Not Modified',
            headers: { get: () => null },
        } as unknown as Response);

        mockMetadataTransaction();

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'unchanged' });

        expect(metadataFetchMock).toHaveBeenCalledWith(
            expect.stringContaining('models.dev'),
            expect.objectContaining({
                headers: { 'If-None-Match': 'W/"v1"' },
            })
        );

        const sql = executedTransactionSql();
        expect(sql.some((statement) => statement.includes('delete from "llm_metadata"'))).toBe(
            false
        );
        expect(statistics.get('model_metadata_last_checked_at')).toBeTruthy();
    });

    it('stores the response ETag after a successful refresh', async () => {
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

        mockMetadataTransaction();

        await expect(updateModelMetadata()).resolves.toEqual({ status: 'updated' });

        expect(statistics.get('model_metadata_source_etag')).toBe('W/"v2"');
    });

    it('rejects an empty remote catalog without clearing cached metadata', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        metadataFetchMock.mockResolvedValue(jsonResponse(catalog({})));

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

        expect(collectInsertParams('llm_metadata')).toEqual(
            expect.arrayContaining(['deepseek/deepseek-v4.1-flash'])
        );
        expect(collectInsertParams('llm_metadata_aliases')).toEqual(
            expect.arrayContaining(['deepseek-v4.1-flash'])
        );

        const sql = executedTransactionSql();
        expect(sql.some((statement) => statement.includes('delete from "llm_metadata"'))).toBe(
            true
        );
        expect(sql.some((statement) => statement.includes('insert into "statistics"'))).toBe(false);
    });

    it('coalesces concurrent checks into a single remote request', async () => {
        mockMetadataTransaction();
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

    it('allows a later check after a failed one', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockMetadataTransaction();
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

    it('treats a missing or unparseable check timestamp as stale', async () => {
        mockMetadataTransaction();

        await expect(shouldCheckModelMetadata()).resolves.toBe(true);

        statistics.set('model_metadata_last_checked_at', 'not-a-date');
        await expect(shouldCheckModelMetadata()).resolves.toBe(true);
    });

    it('skips the remote request while the last check is still fresh', async () => {
        statistics.set('model_metadata_last_checked_at', new Date().toISOString());

        mockMetadataTransaction();

        await expect(shouldCheckModelMetadata()).resolves.toBe(false);

        const result = await refreshModelMetadataIfStale();
        expect(result).toEqual({ status: 'skipped', reason: 'fresh' });
        expect(metadataFetchMock).not.toHaveBeenCalled();
    });

    it('checks the remote catalog once the interval has elapsed', async () => {
        const staleTime = new Date(Date.now() - MODEL_METADATA_CHECK_INTERVAL_MS - 1000);
        statistics.set('model_metadata_last_checked_at', staleTime.toISOString());
        metadataFetchMock.mockResolvedValue(
            jsonResponse(
                catalog({
                    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', reasoning: true },
                })
            )
        );

        mockMetadataTransaction();

        await expect(refreshModelMetadataIfStale()).resolves.toEqual({ status: 'updated' });
        expect(metadataFetchMock).toHaveBeenCalledTimes(1);
    });
});
