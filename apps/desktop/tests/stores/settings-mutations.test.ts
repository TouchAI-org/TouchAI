import { closeTestDatabases } from '@tests/database/sqliteHarness';
import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { afterEach, describe, expect, it, vi } from 'vitest';

let fixture: ReturnType<typeof createSettingsWindowFixture> | undefined;
afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
    closeTestDatabases();
    vi.useRealTimers();
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { nextTick, watch } from 'vue';

describe('given preference writes and refreshes overlap', () => {
    it('user keeps the requested value while a refresh still sees the prior committed snapshot', async () => {
        const entered = deferred();
        const written = deferred();
        let block = false;
        fixture = createSettingsWindowFixture({
            label: 'settings',
            values: { start_minimized: 'true' },
            query: {
                async beforeQuery({ sql, params }) {
                    if (block && sql.startsWith('insert') && params[0] === 'start_minimized') {
                        entered.resolve();
                        await written.promise;
                    }
                },
            },
        });
        await fixture.initialize();
        const store = fixture.store();
        await store.initialize();
        block = true;
        const update = store.updateStartMinimized(false);
        await entered.promise;
        await store.refresh();
        expect(store.settings.startMinimized).toBe(false);
        written.resolve();
        await update;
        expect(store.settings.startMinimized).toBe(false);
        expect(fixture.values.get('start_minimized')).toBe('false');
    });

    it('user saves an unrelated preference without resetting a tool administration draft projection', async () => {
        fixture = createSettingsWindowFixture({ label: 'settings' });
        await fixture.initialize();
        const store = fixture.store();
        const tools = fixture.tools();
        await store.initialize();
        await tools.initialize();
        const initial = tools.searchSettings;
        const changes: unknown[] = [];
        const stop = watch(
            () => tools.searchSettings,
            (value) => changes.push(value),
            { deep: true }
        );
        try {
            await store.updateStartMinimized(false);
            await nextTick();
            expect(tools.searchSettings).toBe(initial);
            expect(changes).toEqual([]);
        } finally {
            stop();
        }
    });

    it('user reopens preferences and sees the effective OS autostart state committed by main', async () => {
        fixture = createSettingsWindowFixture({ values: { start_on_boot: 'true' } });
        const store = fixture.store();
        await store.initialize();
        expect(store.settings.startOnBoot).toBe(true);
        mockTauriCommand('is_autostart_enabled', false);
        await store.refreshStartOnBoot();
        expect(store.settings.startOnBoot).toBe(false);
        expect(fixture.values.get('start_on_boot')).toBe('false');
    });

    it('user changes autostart during an OS read and the late result cannot reverse that choice', async () => {
        fixture = createSettingsWindowFixture({ values: { start_on_boot: 'true' } });
        const store = fixture.store();
        await store.initialize();
        const entered = deferred();
        let resolveState!: (value: boolean) => void;
        mockTauriCommand('is_autostart_enabled', () => {
            entered.resolve();
            return new Promise<boolean>((resolve) => {
                resolveState = resolve;
            });
        });
        const enabledBefore = getTauriInvokeCalls('enable_autostart').length;
        const refresh = store.refreshStartOnBoot();
        await entered.promise;
        await store.updateStartOnBoot(false);
        resolveState(true);
        await refresh;
        expect(store.settings.startOnBoot).toBe(false);
        expect(fixture.values.get('start_on_boot')).toBe('false');
        expect(getTauriInvokeCalls('enable_autostart')).toHaveLength(enabledBefore);
    });
});
