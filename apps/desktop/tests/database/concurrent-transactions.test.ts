import { createDrizzleDb } from '@database/driver';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(closeTestDatabases);

describe('given concurrent writes through the native transaction boundary', () => {
    it('user starts several writes and retains every committed row without overlapping transaction handles', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const db = createDrizzleDb();
        await Promise.all(
            [1, 2, 3].map((id) =>
                db.transaction(async (tx) => {
                    await tx.run(`INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo)
                VALUES (${id}, 'Fixture ${id}', 'openai-compatible', 'https://fixture.invalid', '', 'openai')`);
                })
            )
        );
        expect(database.prepare('SELECT id FROM providers ORDER BY id').all()).toEqual([
            { id: 1 },
            { id: 2 },
            { id: 3 },
        ]);
    });

    it('user has one refused commit and retains only the subsequent successful transaction', async () => {
        const database = openMigratedDatabase();
        let refuse = true;
        routeQueriesTo(database, {
            beforeCommit() {
                if (refuse) {
                    refuse = false;
                    throw new Error('fixture commit refusal');
                }
            },
        });
        const db = createDrizzleDb();
        const writes = await Promise.allSettled(
            [1, 2].map((id) =>
                db.transaction(async (tx) => {
                    await tx.run(`INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo)
                VALUES (${id}, 'Fixture ${id}', 'openai-compatible', 'https://fixture.invalid', '', 'openai')`);
                })
            )
        );
        expect(writes[0]).toMatchObject({
            status: 'rejected',
            reason: new Error('fixture commit refusal'),
        });
        expect(writes[1]).toMatchObject({ status: 'fulfilled' });
        expect(database.prepare('SELECT id FROM providers').all()).toEqual([{ id: 2 }]);
    });
});
