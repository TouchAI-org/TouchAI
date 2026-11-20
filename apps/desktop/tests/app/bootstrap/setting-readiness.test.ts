import { createAgentWindowFixture, network, response } from '@tests/utils/agentWindow';
import { afterEach, describe, expect, it } from 'vitest';

let fixture: ReturnType<typeof createAgentWindowFixture> | undefined;
let releaseRead: (() => void) | undefined;

afterEach(async () => {
    releaseRead?.();
    releaseRead = undefined;
    await fixture?.window.dispose();
    fixture = undefined;
});

function pausedPreferences() {
    let reading = false;
    const waiting = new Promise<void>((resolve) => {
        releaseRead = resolve;
    });
    fixture = createAgentWindowFixture('main', undefined, {
        beforeQuery({ sql }) {
            if (sql.startsWith('select') && sql.includes('from "settings"')) {
                reading = true;
                return waiting;
            }
        },
    });
    fixture.database
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('output_scroll_behavior', 'stay_position');
    fixture.database
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('start_minimized', 'false');
    return { ...fixture, reading: () => reading };
}

describe('given the production Agent waits for its existing preference owner', () => {
    it('user reads the saved preference only after initialization finishes without a fallback read', async () => {
        const main = pausedPreferences();
        network.replies.push(
            response('', false, {
                name: 'builtin__setting',
                arguments: '{"action":"get","keys":["output_scroll_behavior"]}',
            }),
            response('the saved preference is active')
        );
        const pending = main.window.api.startTask({ prompt: 'read my saved scroll preference' });
        await expect.poll(main.reading).toBe(true);
        expect(network.requests).toEqual([]);
        expect(main.window.api.listActiveTasks()).toEqual([]);

        releaseRead!();
        const task = await pending;
        expect((await task.completion).response).toBe('the saved preference is active');
        expect(JSON.stringify(network.requests[1])).toContain('stay_position');
        expect(main.window.settings.getSnapshot().outputScrollBehavior).toBe('stay_position');
    });

    it('user cancels pending preference initialization and no late task changes the saved setting', async () => {
        const main = pausedPreferences();
        const cancellation = new AbortController();
        const pending = main.window.api.startTask({
            prompt: 'change my startup preference',
            signal: cancellation.signal,
        });
        const failure = expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        await expect.poll(main.reading).toBe(true);
        cancellation.abort();
        await failure;
        releaseRead!();
        await main.window.settings.initialize();

        expect(main.window.api.listActiveTasks()).toEqual([]);
        expect(network.requests).toEqual([]);
        expect(
            main.database.prepare('SELECT value FROM settings WHERE key = ?').get('start_minimized')
        ).toEqual({ value: 'false' });
        expect(main.database.prepare('SELECT count(*) AS count FROM session_turns').get()).toEqual({
            count: 0,
        });
    });
});
