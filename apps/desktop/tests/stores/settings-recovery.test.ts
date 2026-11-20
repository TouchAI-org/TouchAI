import { closeTestDatabases } from '@tests/database/sqliteHarness';
import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

let fixture: ReturnType<typeof createSettingsWindowFixture> | undefined;
afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
    closeTestDatabases();
    vi.useRealTimers();
});

describe('given a secondary preferences client cannot become a writer', () => {
    it('user opens before main and can reconcile and retry after the real owner becomes ready', async () => {
        vi.useFakeTimers();
        fixture = createSettingsWindowFixture({
            label: 'settings',
            values: { output_scroll_behavior: 'stay_position' },
        });
        const store = fixture.store();
        const failed = expect(store.initialize()).rejects.toMatchObject({
            code: 'settings-timeout',
        });
        await flushPromises();
        // The existing startup handshake retries within a bounded thirty-second window.
        await vi.advanceTimersByTimeAsync(30_000);
        await failed;
        expect(store.initialized).toBe(false);
        expect(fixture.values.get('output_scroll_behavior')).toBe('stay_position');
        await fixture.owner.api.initialize();
        await flushPromises();
        expect(store.settings.outputScrollBehavior).toBe('stay_position');
        expect(store.initialized).toBe(false);
        await store.initialize();
        expect(store.initialized).toBe(true);
    });

    it('user refreshes after a missed notice and releases only its projection when closing', async () => {
        let drop = false;
        fixture = createSettingsWindowFixture({
            label: 'settings',
            values: { output_scroll_behavior: 'stay_position' },
            query: {
                aroundInvoke(call, next) {
                    const payload = call.payload as { payload?: { kind?: string; type?: string } };
                    if (
                        drop &&
                        call.cmd === 'plugin:event|emit' &&
                        payload?.payload?.kind === 'notice'
                    )
                        return undefined;
                    return next();
                },
            },
        });
        await fixture.initialize();
        const store = fixture.store();
        await store.initialize();
        drop = true;
        fixture.values.set('output_scroll_behavior', 'jump_to_top');
        await fixture.owner.api.refresh();
        await store.refresh();
        drop = false;
        expect(store.settings.outputScrollBehavior).toBe('jump_to_top');
        await store.dispose();
        expect(store.initialized).toBe(false);
        expect(
            (await fixture.owner.api.mutate('output_scroll_behavior', 'follow_output')).status
        ).toBe('committed');
    });
});
