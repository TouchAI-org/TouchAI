import { emit } from '@tauri-apps/api/event';
import { routeQueriesTo } from '@tests/database/sqliteHarness';
import {
    createAgentWindowFixture,
    network,
    response,
    streamingResponse,
} from '@tests/utils/agentWindow';
import { mountComposable } from '@tests/utils/composables';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick, watch } from 'vue';

import type { TaskViewSnapshot } from '@/app/api/agent';
import { agentApiKey } from '@/app/api/agent';
import { AppEvent } from '@/app/api/agent/events';
import { useSessionStatus } from '@/composables/useSessionStatus';

let fixture: ReturnType<typeof createAgentWindowFixture>;
const mounted: (() => void)[] = [];
beforeEach(async () => {
    fixture = createAgentWindowFixture();
    await fixture.window.ready;
});
afterEach(async () => {
    for (const unmount of mounted.splice(0)) unmount();
    await fixture.window.dispose();
});
async function mountStatus() {
    const view = await mountComposable(useSessionStatus, (app) =>
        app.provide(agentApiKey, fixture.window.api)
    );
    mounted.push(view.unmount);
    return view;
}
async function status(sessionId: number, value: TaskViewSnapshot['status']) {
    await emit(AppEvent.SESSION_TASK_STATUS_CHANGED, {
        sessionId,
        taskId: `task-${sessionId}`,
        status: value,
        previousStatus: null,
        reminder: null,
    });
    await nextTick();
}

describe('given the session list uses the production Agent client and native status events', () => {
    it.each(['running', 'waiting_approval'] as const)(
        'user sees a %s badge when a live status arrives',
        async (value) => {
            const { result } = await mountStatus();
            await status(1, value);
            expect(result.getSessionStatus(1)).toBe(value);
        }
    );

    it.each(['completed', 'failed', 'cancelled'] as const)(
        'user loses a busy badge when the session becomes %s',
        async (value) => {
            const { result } = await mountStatus();
            await status(1, 'running');
            await status(1, value);
            expect(result.getSessionStatus(1)).toBeUndefined();
        }
    );

    it('user keeps independent session badges and reactive rendering when events arrive', async () => {
        const { result } = await mountStatus();
        let renders = 0;
        const stop = watch(
            result.sessionStatuses,
            () => {
                renders += 1;
            },
            { deep: true }
        );
        await status(1, 'running');
        await status(2, 'waiting_approval');
        expect(result.getSessionStatus(1)).toBe('running');
        expect(result.getSessionStatus(2)).toBe('waiting_approval');
        expect(renders).toBeGreaterThan(0);
        stop();
    });

    it('user refreshes only currently active sessions through the production task owner', async () => {
        const channel = streamingResponse();
        network.replies.push(channel.response);
        const task = await fixture.window.api.startTask({ prompt: 'keep one session active' });
        await expect
            .poll(() => fixture.window.api.getTaskSnapshot(task.taskId)?.sessionId)
            .toBeTruthy();
        const sessionId = fixture.window.api.getTaskSnapshot(task.taskId)!.sessionId!;
        await expect.poll(() => network.requests.length).toBe(1);
        network.replies.push(response('finished other session'));
        const completed = await fixture.window.api.startTask({ prompt: 'finish another session' });
        await completed.completion;
        const finishedId = fixture.window.api.getTaskSnapshot(completed.taskId)!.sessionId!;
        const { result } = await mountStatus();
        result.refreshAllStatuses([sessionId, finishedId, 999]);
        expect(result.getSessionStatus(sessionId)).toBe('running');
        expect(result.getSessionStatus(finishedId)).toBeUndefined();
        expect(result.getSessionStatus(999)).toBeUndefined();
        channel.delta({ role: 'assistant', content: 'active session finished' });
        channel.finish();
        await task.completion;
    });

    it('user refreshes the requested sessions and omitted earlier badges disappear', async () => {
        const { result } = await mountStatus();
        await status(1, 'running');
        await status(2, 'waiting_approval');
        result.refreshAllStatuses([1]);
        expect(result.sessionStatuses.value.size).toBe(0);
    });

    it('user closes the view and later native status changes cannot revive its badges', async () => {
        const { result, unmount } = await mountStatus();
        await status(1, 'running');
        const registrations = getTauriInvokeCalls('plugin:event|listen').filter(
            ({ payload }) =>
                (payload as { event: string }).event === AppEvent.SESSION_TASK_STATUS_CHANGED
        );
        expect(registrations).toHaveLength(1);
        unmount();
        await status(2, 'running');
        expect(result.getSessionStatus(2)).toBeUndefined();
        expect(
            getTauriInvokeCalls('plugin:event|unlisten').map(({ payload }) => payload)
        ).toContainEqual(expect.objectContaining({ event: AppEvent.SESSION_TASK_STATUS_CHANGED }));
    });

    it('user closes before native registration resolves and its late listener is released', async () => {
        const admission = Promise.withResolvers<void>();
        routeQueriesTo(fixture.database, {
            aroundInvoke: async (call, next) => {
                if (
                    call.cmd === 'plugin:event|listen' &&
                    (call.payload as { event: string }).event ===
                        AppEvent.SESSION_TASK_STATUS_CHANGED
                )
                    await admission.promise;
                return next();
            },
        });
        const { result, unmount } = await mountStatus();
        unmount();
        admission.resolve();
        await expect
            .poll(
                () =>
                    getTauriInvokeCalls('plugin:event|unlisten').filter(
                        ({ payload }) =>
                            (payload as { event: string }).event ===
                            AppEvent.SESSION_TASK_STATUS_CHANGED
                    ).length
            )
            .toBe(1);
        await status(1, 'running');
        expect(result.sessionStatuses.value.size).toBe(0);
    });

    it('user retains an empty usable list after native subscription fails and a new view can subscribe again', async () => {
        let refuse = true;
        routeQueriesTo(fixture.database, {
            aroundInvoke: (call, next) => {
                if (
                    refuse &&
                    call.cmd === 'plugin:event|listen' &&
                    (call.payload as { event: string }).event ===
                        AppEvent.SESSION_TASK_STATUS_CHANGED
                )
                    throw new Error('fixture native bridge unavailable');
                return next();
            },
        });
        const failed = await mountStatus();
        expect(failed.result.sessionStatuses.value.size).toBe(0);
        failed.unmount();
        refuse = false;
        const following = await mountStatus();
        await status(1, 'running');
        expect(following.result.getSessionStatus(1)).toBe('running');
    });
});
