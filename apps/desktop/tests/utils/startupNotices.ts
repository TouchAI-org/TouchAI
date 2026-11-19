import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach } from 'vitest';
import type { App } from 'vue';

import { startupNoticesApiKey } from '@/app/api/search/startup';
import { createStartupNotices } from '@/app/workflows/data-management/notices';

const owners = new Set<ReturnType<typeof createStartupNotices>>();

/** Real notice consumption over the same SQLite boundary used by main bootstrap. */
export function createStartupNoticeFixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database
        .prepare('INSERT INTO touchai_meta (key, value) VALUES (?, ?)')
        .run('import_success', 'fixture startup notice');
    const owner = createStartupNotices({ initializePreferences: async () => undefined });
    owners.add(owner);
    return {
        provide(app: App) {
            app.provide(startupNoticesApiKey, { consume: owner.consume });
        },
        get consumed() {
            return !database
                .prepare('SELECT value FROM touchai_meta WHERE key = ?')
                .get('import_success');
        },
    };
}

afterEach(() => {
    for (const owner of owners) owner.dispose();
    owners.clear();
    closeTestDatabases();
});
