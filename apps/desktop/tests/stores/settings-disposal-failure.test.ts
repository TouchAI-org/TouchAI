import { closeTestDatabases } from '@tests/database/sqliteHarness';
import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { afterEach, describe, expect, it } from 'vitest';

let fixture: ReturnType<typeof createSettingsWindowFixture> | undefined;
afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
    closeTestDatabases();
});

import { disposePinia } from 'pinia';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

describe('given a preferences projection is detached during startup', () => {
    it('user closes the projection while storage fails and receives no late ready state or error', async () => {
        const entered = deferred();
        const read = deferred();
        fixture = createSettingsWindowFixture({
            query: {
                async beforeQuery({ sql }) {
                    if (!sql.startsWith('select')) return;
                    entered.resolve();
                    await read.promise;
                    throw new Error('storage read failed');
                },
            },
        });
        const store = fixture.store();
        const initialization = store.initialize();
        await entered.promise;
        await store.dispose();
        read.resolve();
        await expect(initialization).resolves.toBeUndefined();
        expect(store.initialized).toBe(false);
        expect(store.loading).toBe(false);
        expect(store.settings.language).toBe('zh-CN');
    });

    it('user detaches one preferences projection and the existing main writer still serves another window', async () => {
        fixture = createSettingsWindowFixture({ values: { language: 'zh-CN' } });
        const store = fixture.store();
        await store.initialize();
        disposePinia(fixture.pinia);
        const client = fixture.createClient('settings');
        await client.api.initialize();
        expect((await client.api.mutate('language', 'en-US')).status).toBe('committed');
        expect(fixture.owner.api.getSnapshot().language).toBe('en-US');
        expect(store.settings.language).toBe('zh-CN');
    });
});
