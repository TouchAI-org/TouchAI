import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, beforeEach } from 'vitest';

import { createWebSearchTools, readWebSearchConfiguration } from '@/modules/tools';

let database: ReturnType<typeof openMigratedDatabase>;
beforeEach(() => {
    database = openMigratedDatabase();
    routeQueriesTo(database);
});
afterEach(closeTestDatabases);

export function saveWebSearchSettings(value: string | null): void {
    if (value === null)
        database.prepare('DELETE FROM settings WHERE key = ?').run('search_settings');
    else
        database
            .prepare(
                'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
            )
            .run('search_settings', value);
}

export function createWebSearchToolsFixture() {
    const tools = createWebSearchTools({ configuration: { read: readWebSearchConfiguration } });
    const tool = tools[0]!;
    const prepared = () => tool.prepareForTurn(tool.defaultConfig);
    return {
        tools,
        tool,
        async definition(name: string) {
            const ready = await prepared();
            return ready.buildToolDefinition(name, ready.defaultConfig);
        },
        async execute(...args: Parameters<typeof tool.execute>) {
            return (await prepared()).execute(...args);
        },
    };
}
