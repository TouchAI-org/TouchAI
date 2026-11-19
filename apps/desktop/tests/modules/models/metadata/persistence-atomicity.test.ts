import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelMetadata } from '@/modules/models';
import { persistRefreshedModels } from '@/modules/models/metadata/refresh.io';

afterEach(closeTestDatabases);

function fixture() {
    const database = openMigratedDatabase();
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Fixture', 'openai', 'https://fixture.invalid', 'openai');
        INSERT INTO models (id, provider_id, model_id, name, context_limit)
        VALUES (1, 1, 'fixture-model', 'Saved', 100);
        INSERT INTO llm_metadata (model_id, name, modalities, "limit")
        VALUES ('fixture/fixture-model', 'Old catalog', '{"input":["text"],"output":["text"]}', '{"context":100}');
        INSERT INTO llm_metadata_aliases (alias, model_id)
        VALUES ('fixture-model', 'fixture/fixture-model');`);
    let fail = true;
    routeQueriesTo(database, {
        beforeQuery(request) {
            if (fail && request.sql.includes('WITH selected_model_metadata AS')) {
                throw new Error('fixture synchronization write rejected');
            }
        },
    });
    return {
        database,
        recover() {
            fail = false;
        },
        snapshot() {
            return {
                models: database.prepare('SELECT * FROM models ORDER BY id').all(),
                catalog: database.prepare('SELECT * FROM llm_metadata ORDER BY model_id').all(),
                aliases: database
                    .prepare('SELECT * FROM llm_metadata_aliases ORDER BY alias')
                    .all(),
                statistics: database.prepare('SELECT * FROM statistics ORDER BY key').all(),
            };
        },
    };
}

describe('given a synchronization failure inside the existing metadata transaction', () => {
    it('user retains saved rows and exact upstream bytes after a discovery failure and can refresh later', async () => {
        const state = fixture();
        const saved = state.snapshot();
        const discovery = {
            providerId: 1,
            models: [
                {
                    id: 'fixture-model',
                    name: 'Renamed upstream',
                    capabilities: { contextLimit: 200 },
                },
                { id: 'new-model', name: 'New', capabilities: { contextLimit: 300 } },
            ],
        };
        await expect(persistRefreshedModels(discovery)).rejects.toMatchObject({
            cause: { message: 'fixture synchronization write rejected' },
        });
        expect(state.snapshot()).toEqual(saved);
        state.recover();
        await expect(persistRefreshedModels(discovery)).resolves.toEqual({ addedCount: 1 });
        expect(
            state.database
                .prepare('SELECT context_limit, upstream_metadata FROM models WHERE id = 1')
                .get()
        ).toMatchObject({ context_limit: 200, upstream_metadata: '{"context_limit":200}' });
    });

    it('user keeps the previous catalog and freshness statistics after replacement fails and can retry safely', async () => {
        const state = fixture();
        const saved = state.snapshot();
        const metadata = createModelMetadata({
            fetch: async () =>
                Response.json(
                    {
                        fixture: {
                            models: {
                                'fixture-model': {
                                    id: 'fixture-model',
                                    name: 'New catalog',
                                    limit: { context: 500 },
                                },
                            },
                        },
                    },
                    { headers: { etag: 'fixture-etag' } }
                ),
            report() {},
        });
        try {
            await expect(metadata.refresh({ force: true })).rejects.toMatchObject({
                cause: { message: 'fixture synchronization write rejected' },
            });
            expect(state.snapshot()).toEqual(saved);
            state.recover();
            await expect(metadata.refresh({ force: true })).resolves.toEqual({ status: 'updated' });
            expect(
                state.database.prepare('SELECT context_limit FROM models WHERE id = 1').get()
            ).toMatchObject({ context_limit: 500 });
            expect(state.snapshot().statistics).not.toEqual(saved.statistics);
        } finally {
            await metadata.dispose();
        }
    });
});
