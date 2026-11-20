import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { deferred } from '@tests/utils/productAnalytics';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

const windows: ReturnType<typeof initializeAgentWindow>[] = [];
afterEach(async () => {
    for (const host of windows.splice(0).reverse()) await host.dispose();
});
async function main() {
    const fixture = createAgentWindowFixture();
    windows.push(fixture.window);
    await fixture.window.ready;
    return fixture;
}
function settings() {
    mockWindows('settings');
    const client = initializeAgentWindow();
    windows.push(client);
    return client;
}

describe('given production model configuration ownership', () => {
    it('user given ordinary windows when reading model capabilities then cannot read credentials or obtain an administration writer', async () => {
        const fixture = await main();
        expect(fixture.window.modelAdministration).toBeUndefined();
        mockWindows('tray-menu');
        const tray = initializeAgentWindow();
        windows.push(tray);
        expect(tray.modelAdministration).toBeUndefined();
        expect(Object.keys(fixture.window.models)).toEqual(['listModels']);
    });

    it('user given settings when changing a saved profile then reads and preserves exact configuration bytes through main', async () => {
        const fixture = await main();
        const api = settings().modelAdministration!;
        expect((await api.findAllProvidersSorted())[0]?.api_key).toBe('fixture-secret');
        const config = '{ "headers" : { "x-fixture" : "unchanged bytes" } }';
        await api.updateProvider({ id: 1, providerPatch: { config_json: config } });
        expect(
            fixture.database.prepare('SELECT config_json FROM providers WHERE id = 1').get()
        ).toEqual({ config_json: config });
    });

    it('user given a default model when disabling or deleting its provider then is refused by the owner without changing rows', async () => {
        const fixture = await main();
        const api = settings().modelAdministration!;
        await expect(
            api.updateProvider({ id: 1, providerPatch: { enabled: 0 } })
        ).rejects.toMatchObject({ code: 'PROVIDER_HAS_DEFAULT_MODEL' });
        await expect(api.deleteProvider({ id: 1 })).rejects.toMatchObject({
            code: 'PROVIDER_HAS_DEFAULT_MODEL',
        });
        expect(
            fixture.database.prepare('SELECT enabled FROM providers WHERE id = 1').get()
        ).toEqual({ enabled: 1 });
        expect(
            fixture.database.prepare('SELECT is_default FROM models WHERE id = 1').get()
        ).toEqual({ is_default: 1 });
    });

    it('user given a disabled provider when choosing its model as default then preserves the existing activation and native default transaction', async () => {
        const fixture = await main();
        fixture.database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, logo, enabled)
            VALUES (2, 'Other', 'openai-compatible', 'https://other.invalid', 'openai', 0);
            INSERT INTO models (id, provider_id, name, model_id) VALUES (2, 2, 'Other', 'other');`);
        await settings().modelAdministration!.setDefaultModel({ modelId: 2 });
        expect(
            fixture.database.prepare('SELECT id, is_default FROM models ORDER BY id').all()
        ).toEqual([
            { id: 1, is_default: 0 },
            { id: 2, is_default: 1 },
        ]);
        expect(
            fixture.database.prepare('SELECT enabled FROM providers WHERE id = 2').get()
        ).toEqual({ enabled: 1 });
    });

    it('user given a failed default write when retrying explicitly then keeps the previous default and receives safe errors', async () => {
        const fixture = await main();
        fixture.database
            .exec(`INSERT INTO models (id, provider_id, name, model_id) VALUES (2, 1, 'Other', 'other');
            CREATE TEMP TRIGGER reject_default BEFORE UPDATE ON models WHEN NEW.id = 2
            BEGIN SELECT RAISE(ABORT, 'private SQL fixture'); END;`);
        const api = settings().modelAdministration!;
        await expect(api.setDefaultModel({ modelId: 2 })).rejects.toMatchObject({
            code: 'MODEL_ADMINISTRATION_FAILED',
            message: 'MODEL_ADMINISTRATION_FAILED',
        });
        expect(
            fixture.database.prepare('SELECT id FROM models WHERE is_default = 1').all()
        ).toEqual([{ id: 1 }]);
        fixture.database.exec('DROP TRIGGER reject_default');
        await api.setDefaultModel({ modelId: 2 });
        expect((await api.findDefaultModel())?.id).toBe(2);
    });

    it('user given invalid internal fields or a detached client when submitting a profile patch then begins no write', async () => {
        const fixture = await main();
        const client = settings();
        await expect(
            client.modelAdministration!.updateProvider({
                id: 1,
                providerPatch: { id: 100 } as never,
            })
        ).rejects.toMatchObject({ code: 'MODEL_ADMINISTRATION_UNAVAILABLE' });
        await client.dispose();
        await expect(
            client.modelAdministration!.updateProvider({ id: 1, providerPatch: { name: 'late' } })
        ).rejects.toMatchObject({ code: 'MODEL_ADMINISTRATION_UNAVAILABLE' });
        expect(fixture.database.prepare('SELECT id, name FROM providers').all()).toEqual([
            { id: 1, name: 'Fixture' },
        ]);
    });

    it('user given queued profile changes when main closes then finishes only the already admitted native write', async () => {
        const paused = deferred<void>();
        const resume = deferred<void>();
        const fixture = createAgentWindowFixture('main', undefined, {
            beforeQuery: ({ sql }) => {
                if (sql.startsWith('update "providers"')) {
                    paused.resolve();
                    return resume.promise;
                }
            },
        });
        windows.push(fixture.window);
        await fixture.window.ready;
        const client = settings();
        const api = client.modelAdministration!;
        const first = api.updateProvider({ id: 1, providerPatch: { name: 'Admitted' } });
        const firstFailure = expect(first).rejects.toMatchObject({ outcome: 'unknown' });
        await paused.promise;
        const second = api.updateProvider({ id: 1, providerPatch: { name: 'Queued' } });
        const secondFailure = expect(second).rejects.toMatchObject({ outcome: 'unknown' });
        await flushPromises();
        const stop = fixture.window.dispose();
        await client.dispose();
        resume.resolve();
        await stop;
        await Promise.all([firstFailure, secondFailure]);
        expect(fixture.database.prepare('SELECT name FROM providers WHERE id = 1').get()).toEqual({
            name: 'Admitted',
        });
    });
});
