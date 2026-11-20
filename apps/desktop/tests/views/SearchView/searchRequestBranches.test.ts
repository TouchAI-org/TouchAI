import { emit } from '@tauri-apps/api/event';
import { routeQueriesTo } from '@tests/database/sqliteHarness';
import { mountSearchFlow, searchRequestFixture } from '@tests/utils/searchRequest';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { AppEvent } from '@/app/api/search/events';

const isHistory = (sql: string) =>
    sql.startsWith('select') && sql.includes('from "sessions"') && sql.includes('limit');
const ids = (flow: Awaited<ReturnType<typeof mountSearchFlow>>) =>
    flow.result.sessionList.value.map((session) => session.id).sort();

describe('given Search history uses current session queries and native event delivery', () => {
    it('user opens history concurrently and receives one shared result without duplicate native reads', async () => {
        const flow = await mountSearchFlow();
        const fixture = searchRequestFixture();
        let queries = 0;
        routeQueriesTo(fixture.database, {
            beforeQuery: ({ sql }) => {
                if (isHistory(sql)) queries++;
            },
        });
        await Promise.all([
            flow.result.ensureSessionListLoaded(),
            flow.result.ensureSessionListLoaded(),
        ]);
        expect(ids(flow)).toEqual([7, 8]);
        expect(queries).toBe(1);
        await flow.result.setSessionHistoryOverlayOpen(true);
        await flow.result.ensureSessionListLoaded();
        expect(queries).toBe(1);
        await flow.result.setSessionHistoryOverlayOpen(false);
        await flow.result.ensureSessionListLoaded();
        expect(ids(flow)).toEqual([7, 8]);
        expect(queries).toBe(1);
    });

    it('user types while the popup is closed and no history query begins', async () => {
        const flow = await mountSearchFlow();
        let queries = 0;
        routeQueriesTo(searchRequestFixture().database, {
            beforeQuery: ({ sql }) => {
                if (isHistory(sql)) queries++;
            },
        });
        await flow.result.updateSessionSearchQuery('Alpha');
        expect(queries).toBe(0);
        expect(flow.result.sessionListQuery.value).toBe('Alpha');
    });

    it('user types rapidly and only the final history query reaches SQLite while every caller settles', async () => {
        const flow = await mountSearchFlow();
        await flow.result.setSessionHistoryOverlayOpen(true);
        vi.useFakeTimers();
        const first = flow.result.updateSessionSearchQuery('Al');
        const second = flow.result.updateSessionSearchQuery('Alpha');
        await first;
        await vi.advanceTimersByTimeAsync(150);
        await second;
        expect(ids(flow)).toEqual([7]);
        expect(flow.result.isSessionListLoading.value).toBe(false);
        await flow.result.setSessionHistoryOverlayOpen(false);
        expect(flow.result.sessionList.value).toEqual([]);
        expect(flow.result.sessionListQuery.value).toBe('');
    });

    it('user types a newer query and an old pending query cannot publish during its debounce', async () => {
        const flow = await mountSearchFlow();
        const fixture = searchRequestFixture();
        await flow.result.setSessionHistoryOverlayOpen(true);
        const old = Promise.withResolvers<void>();
        let held = false;
        routeQueriesTo(fixture.database, {
            beforeQuery: ({ sql }) => {
                if (isHistory(sql) && !held) {
                    held = true;
                    return old.promise;
                }
            },
        });
        const initial = flow.result.refreshSessionList();
        await expect.poll(() => held).toBe(true);
        vi.useFakeTimers();
        const updated = flow.result.updateSessionSearchQuery('Beta');
        old.resolve();
        await initial;
        expect(flow.result.sessionList.value).toEqual([]);
        await vi.advanceTimersByTimeAsync(150);
        await updated;
        expect(ids(flow)).toEqual([8]);
    });

    it('user receives the newest filter when an older response finishes after it', async () => {
        const flow = await mountSearchFlow();
        const fixture = searchRequestFixture();
        await flow.result.setSessionHistoryOverlayOpen(true);
        const old = Promise.withResolvers<void>();
        let held = false;
        routeQueriesTo(fixture.database, {
            beforeQuery: ({ sql }) => {
                if (isHistory(sql) && !held) {
                    held = true;
                    return old.promise;
                }
            },
        });
        const initial = flow.result.refreshSessionList();
        await expect.poll(() => held).toBe(true);
        await flow.result.updateSessionSearchQuery('Beta');
        expect(ids(flow)).toEqual([8]);
        old.resolve();
        await initial;
        expect(ids(flow)).toEqual([8]);
    });

    it('user sees a failed history read clear stale rows and can load again after storage recovers', async () => {
        const flow = await mountSearchFlow();
        await flow.result.refreshSessionList();
        let fail = true;
        routeQueriesTo(searchRequestFixture().database, {
            beforeQuery: ({ sql }) => {
                if (fail && isHistory(sql)) throw new Error('fixture read unavailable');
            },
        });
        await flow.result.refreshSessionList();
        expect(flow.result.sessionList.value).toEqual([]);
        expect(flow.result.isSessionListLoading.value).toBe(false);
        fail = false;
        await flow.result.ensureSessionListLoaded();
        expect(ids(flow)).toEqual([7, 8]);
    });

    it('user closes a pending history popup and a late response cannot refill it', async () => {
        const flow = await mountSearchFlow();
        await flow.result.setSessionHistoryOverlayOpen(true);
        const pause = Promise.withResolvers<void>();
        let held = false;
        routeQueriesTo(searchRequestFixture().database, {
            beforeQuery: ({ sql }) => {
                if (isHistory(sql)) {
                    held = true;
                    return pause.promise;
                }
            },
        });
        const pending = flow.result.refreshSessionList();
        await expect.poll(() => held).toBe(true);
        await flow.result.setSessionHistoryOverlayOpen(false);
        pause.resolve();
        await pending;
        expect(flow.result.sessionList.value).toEqual([]);
        expect(flow.result.isSessionListLoading.value).toBe(false);
    });

    it.each(['completed', 'failed'] as const)(
        'user receives a %s status and an open history popup refreshes committed rows',
        async (status) => {
            const flow = await mountSearchFlow();
            await flow.result.setSessionHistoryOverlayOpen(true);
            await flow.result.refreshSessionList();
            searchRequestFixture().database.exec(
                "UPDATE sessions SET title = 'Updated title' WHERE id = 8"
            );
            await emit(AppEvent.SESSION_TASK_STATUS_CHANGED, {
                sessionId: 8,
                taskId: 'other-task',
                status,
                previousStatus: 'running',
                reminder: null,
            });
            await expect
                .poll(
                    () => flow.result.sessionList.value.find((session) => session.id === 8)?.title
                )
                .toBe('Updated title');
        }
    );

    it('user receives a running status and the history cache is kept until a terminal event', async () => {
        const flow = await mountSearchFlow();
        await flow.result.refreshSessionList();
        let queries = 0;
        routeQueriesTo(searchRequestFixture().database, {
            beforeQuery: ({ sql }) => {
                if (isHistory(sql)) queries++;
            },
        });
        await emit(AppEvent.SESSION_TASK_STATUS_CHANGED, {
            sessionId: 8,
            taskId: 'other',
            status: 'running',
            previousStatus: null,
            reminder: null,
        });
        await flow.result.ensureSessionListLoaded();
        expect(queries).toBe(0);
    });

    it('user unmounts a view and its native session listener is released', async () => {
        const flow = await mountSearchFlow();
        flow.unmount();
        await nextTick();
        await expect
            .poll(() => getTauriInvokeCalls('plugin:event|unlisten').map((call) => call.payload))
            .toContainEqual(
                expect.objectContaining({ event: AppEvent.SESSION_TASK_STATUS_CHANGED })
            );
    });

    it('user unmounts before native listener admission finishes and the late registration releases immediately', async () => {
        const admission = Promise.withResolvers<void>();
        routeQueriesTo(searchRequestFixture().database, {
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
        const flow = await mountSearchFlow();
        flow.unmount();
        admission.resolve();
        await expect
            .poll(
                () =>
                    getTauriInvokeCalls('plugin:event|unlisten').filter(
                        (call) =>
                            (call.payload as { event: string }).event ===
                            AppEvent.SESSION_TASK_STATUS_CHANGED
                    ).length
            )
            .toBeGreaterThan(0);
    });

    it('user cannot subscribe to native status updates and can still open committed history', async () => {
        routeQueriesTo(searchRequestFixture().database, {
            aroundInvoke: (call, next) => {
                if (
                    call.cmd === 'plugin:event|listen' &&
                    (call.payload as { event: string }).event ===
                        AppEvent.SESSION_TASK_STATUS_CHANGED
                )
                    throw new Error('fixture subscription refused');
                return next();
            },
        });
        const flow = await mountSearchFlow();
        await flow.result.refreshSessionList();
        expect(ids(flow)).toEqual([7, 8]);
    });
});
