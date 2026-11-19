import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createModelMetadata, MODEL_METADATA_CHECK_INTERVAL_MS } from '@/modules/models';
import { createTauriFetch } from '@/platform/http';

import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '../../database/sqliteHarness';
import { getTauriInvokeCalls } from '../../utils/tauri';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: network.fetch }));
let database: ReturnType<typeof openMigratedDatabase>;
let owner: ReturnType<typeof createModelMetadata>;
beforeEach(() => {
    network.fetch.mockReset();
    database = openMigratedDatabase();
    routeQueriesTo(database);
    owner = createModelMetadata({ fetch: createTauriFetch(), report: () => undefined });
});
afterEach(async () => {
    await owner.dispose();
    closeTestDatabases();
    vi.useRealTimers();
});

function catalog(models: Record<string, unknown>, alias: Record<string, string> = {}) {
    return { models, alias };
}
function oneModel() {
    return catalog(
        { 'openai/fixture': { id: 'fixture', name: 'Fixture', reasoning: true } },
        { fixture: 'openai/fixture' }
    );
}
function statistic(key: string) {
    return database.prepare('SELECT value FROM statistics WHERE key = ?').get(key)?.value;
}
function setStatistic(key: string, value: string) {
    database
        .prepare('INSERT OR REPLACE INTO statistics (key, value) VALUES (?, ?)')
        .run(key, value);
}
function seedCache() {
    database.exec(`INSERT INTO llm_metadata (model_id, name, modalities) VALUES ('old/model', 'Previous', '{"input":["text"],"output":["text"]}');
        INSERT INTO llm_metadata_aliases (alias, model_id) VALUES ('old-model', 'old/model');`);
}

describe('given the Models owner refreshes its existing local metadata cache', () => {
    it('user sees one row per canonical model with prefix-distinct ids kept apart', async () => {
        network.fetch.mockResolvedValue(
            Response.json(
                catalog({
                    'gpt-4': { id: 'gpt-4', name: 'GPT-4' },
                    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' },
                })
            )
        );
        expect(await owner.refresh({ force: true })).toEqual({ status: 'updated' });
        expect(
            database.prepare('SELECT model_id FROM llm_metadata ORDER BY model_id').all()
        ).toEqual([{ model_id: 'gpt-4' }, { model_id: 'gpt-4o' }]);
    });

    it('user sees relay spellings stored as aliases beside the canonical model', async () => {
        network.fetch.mockResolvedValue(
            Response.json(
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
        await owner.refresh({ force: true });
        expect(
            database
                .prepare('SELECT model_id FROM llm_metadata_aliases WHERE alias = ?')
                .get('deepseek-v4.1-flash')
        ).toEqual({ model_id: 'deepseek/deepseek-v4.1-flash' });
    });

    it('user sees refreshed capabilities applied to saved models in the same committed update', async () => {
        database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES (1, 'Fixture', 'openai-compatible', 'https://fixture.invalid/v1', 'openai');
            INSERT INTO models (id, provider_id, name, model_id) VALUES (7, 1, 'MiMo', 'mimo-v2.5-pro');`);
        network.fetch.mockResolvedValue(
            Response.json(
                catalog(
                    {
                        'xiaomi/mimo-v2.5-pro': {
                            id: 'mimo-v2.5-pro',
                            name: 'MiMo',
                            attachment: true,
                            reasoning: true,
                            tool_call: true,
                            modalities: { input: ['text', 'image'], output: ['text'] },
                            limit: { context: 1000000, output: 65536 },
                        },
                    },
                    { 'mimo-v2.5-pro': 'xiaomi/mimo-v2.5-pro' }
                )
            )
        );
        await owner.refresh({ force: true });
        expect(
            database
                .prepare(
                    'SELECT attachment, reasoning, context_limit, output_limit, modalities FROM models WHERE id = 7'
                )
                .get()
        ).toEqual({
            attachment: 1,
            reasoning: 1,
            context_limit: 1000000,
            output_limit: 65536,
            modalities: '{"input":["text","image"],"output":["text"]}',
        });
    });

    it('user keeps the cache unchanged when a conditional request receives an unchanged catalog', async () => {
        seedCache();
        setStatistic('model_metadata_source_etag', 'W/"v1"');
        network.fetch.mockResolvedValue(new Response(null, { status: 304 }));
        expect(await owner.refresh({ force: true })).toEqual({ status: 'unchanged' });
        expect(new Headers(network.fetch.mock.calls[0]?.[1].headers).get('if-none-match')).toBe(
            'W/"v1"'
        );
        expect(database.prepare('SELECT model_id FROM llm_metadata').all()).toEqual([
            { model_id: 'old/model' },
        ]);
        expect(statistic('model_metadata_last_checked_at')).toEqual(expect.any(String));
        expect(statistic('model_metadata_last_updated_at')).toBeUndefined();
    });

    it('user sees the source change marker and update timestamp committed after a successful refresh', async () => {
        network.fetch.mockResolvedValue(Response.json(oneModel(), { headers: { etag: 'W/"v2"' } }));
        await owner.refresh({ force: true });
        expect(statistic('model_metadata_source_etag')).toBe('W/"v2"');
        expect(statistic('model_metadata_last_checked_at')).toEqual(
            statistic('model_metadata_last_updated_at')
        );
    });

    it('user keeps the cached metadata when the upstream catalog is empty', async () => {
        seedCache();
        network.fetch.mockResolvedValue(Response.json(catalog({})));
        await expect(owner.refresh({ force: true })).rejects.toThrow(
            'Refusing to replace model metadata with an empty catalog'
        );
        expect(database.prepare('SELECT model_id FROM llm_metadata').all()).toEqual([
            { model_id: 'old/model' },
        ]);
        expect(statistic('model_metadata_last_updated_at')).toBeUndefined();
    });

    it('user keeps both aliases and metadata when the native cache replacement transaction fails', async () => {
        seedCache();
        database.exec(
            `CREATE TEMP TRIGGER reject_catalog BEFORE INSERT ON llm_metadata BEGIN SELECT RAISE(ABORT, 'fixture metadata refusal'); END;`
        );
        network.fetch.mockResolvedValue(Response.json(oneModel()));
        await expect(owner.refresh({ force: true })).rejects.toBeInstanceOf(Error);
        expect(database.prepare('SELECT model_id FROM llm_metadata').all()).toEqual([
            { model_id: 'old/model' },
        ]);
        expect(database.prepare('SELECT alias FROM llm_metadata_aliases').all()).toEqual([
            { alias: 'old-model' },
        ]);
        expect(statistic('model_metadata_last_updated_at')).toBeUndefined();
        database.exec('DROP TRIGGER reject_catalog');
        network.fetch.mockResolvedValue(Response.json(oneModel()));
        expect(await owner.refresh({ force: true })).toEqual({ status: 'updated' });
        expect(database.prepare('SELECT model_id FROM llm_metadata').all()).toEqual([
            { model_id: 'openai/fixture' },
        ]);
    });

    it('user gets the bundled snapshot only when initialization finds an empty cache without a remote-refresh marker', async () => {
        await owner.initialize();
        expect(
            database
                .prepare('SELECT model_id FROM llm_metadata WHERE model_id = ?')
                .get('deepseek/deepseek-v4.1-flash')
        ).toEqual({ model_id: 'deepseek/deepseek-v4.1-flash' });
        expect(
            database
                .prepare('SELECT model_id FROM llm_metadata_aliases WHERE alias = ?')
                .get('deepseek-v4.1-flash')
        ).toEqual({ model_id: 'deepseek/deepseek-v4.1-flash' });
        expect(statistic('model_metadata_last_updated_at')).toBeUndefined();
        expect(network.fetch.mock.calls).toEqual([]);
    });

    it('user shares one request when the same owner receives concurrent refresh commands', async () => {
        network.fetch.mockResolvedValue(Response.json(oneModel()));
        expect(await Promise.all([owner.refresh(), owner.refresh()])).toEqual([
            { status: 'updated' },
            { status: 'updated' },
        ]);
        expect(network.fetch.mock.calls.map(([url]) => url)).toEqual([
            'https://models.dev/api.json',
        ]);
    });

    it('user can issue a later refresh after the previous network request fails', async () => {
        network.fetch
            .mockRejectedValueOnce(new Error('fixture network down'))
            .mockResolvedValueOnce(Response.json(oneModel()));
        await expect(owner.refresh()).rejects.toThrow('fixture network down');
        expect(await owner.refresh()).toEqual({ status: 'updated' });
        expect(network.fetch.mock.calls).toHaveLength(2);
    });

    it('user sees a missing or unreadable refresh timestamp treated as stale', async () => {
        expect(await owner.shouldCheck()).toBe(true);
        setStatistic('model_metadata_last_checked_at', 'not-a-date');
        expect(await owner.shouldCheck()).toBe(true);
    });

    it('user avoids a catalog request while the last successful check is fresh', async () => {
        setStatistic('model_metadata_last_checked_at', new Date().toISOString());
        expect(await owner.shouldCheck()).toBe(false);
        expect(await owner.refresh()).toEqual({ status: 'skipped', reason: 'fresh' });
        expect(network.fetch.mock.calls).toEqual([]);
    });

    it('user gets a new catalog request once the existing refresh interval has passed', async () => {
        setStatistic(
            'model_metadata_last_checked_at',
            new Date(Date.now() - MODEL_METADATA_CHECK_INTERVAL_MS - 1000).toISOString()
        );
        network.fetch.mockResolvedValue(Response.json(oneModel()));
        expect(await owner.refresh()).toEqual({ status: 'updated' });
        expect(network.fetch.mock.calls).toHaveLength(1);
    });

    it('user closes main while a native request ignores abort and no late response changes the cache', async () => {
        seedCache();
        let respond!: (value: Response) => void;
        network.fetch.mockImplementation(
            () =>
                new Promise<Response>((resolve) => {
                    respond = resolve;
                })
        );
        const pending = owner.refresh({ force: true });
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await expect.poll(() => network.fetch.mock.calls.length).toBe(1);
        await owner.dispose();
        await cancelled;
        const reads = getTauriInvokeCalls('database_query').length;
        respond(Response.json(oneModel()));
        await Promise.resolve();
        await Promise.resolve();
        expect(database.prepare('SELECT model_id FROM llm_metadata').all()).toEqual([
            { model_id: 'old/model' },
        ]);
        expect(getTauriInvokeCalls('database_query')).toHaveLength(reads);
    });

    it('user cancels before requesting a refresh without starting shared network or storage work', async () => {
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(owner.refresh({ signal: cancelled.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(network.fetch.mock.calls).toEqual([]);
        expect(getTauriInvokeCalls('database_query')).toEqual([]);
    });

    it('user sees a bounded metadata timeout and can issue a following refresh', async () => {
        vi.useFakeTimers();
        network.fetch.mockImplementationOnce(() => new Promise(() => {}));
        const pending = owner.refresh({ force: true });
        const timeout = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
        await vi.advanceTimersByTimeAsync(60_000);
        await timeout;
        network.fetch.mockResolvedValue(Response.json(oneModel()));
        expect(await owner.refresh({ force: true })).toEqual({ status: 'updated' });
    });
});
