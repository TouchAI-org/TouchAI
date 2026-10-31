import type { SessionEntity } from '@database/types';
import { mountComposable } from '@tests/utils/composables';
import { deferred, installProductAnalytics } from '@tests/utils/productAnalytics';
import { mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { createInputHistorySnapshot } from '@/types/session';
import { useSearchRequestFlow } from '@/views/SearchView/composables/useSearchRequest';

function session(id: number): SessionEntity {
    return {
        id,
        session_id: `session-${id}`,
        title: `Session ${id}`,
        model: 'gpt-5',
        provider_id: 1,
        last_message_preview: null,
        last_message_at: null,
        message_count: 0,
        status_badge_dismissed_turn_id: null,
        pending_terminal_status: null,
        pinned_at: null,
        archived_at: null,
        created_at: '2026-05-16T00:00:00.000Z',
        updated_at: '2026-05-16T00:00:00.000Z',
    };
}

function response(rows: object[] = []) {
    return { rows, rowsAffected: 0, lastInsertId: null };
}

async function mountFlow() {
    return mountComposable(() =>
        useSearchRequestFlow({
            modelOverride: ref({ modelId: null, providerId: null }),
            clearDraft: () => undefined,
            getSupportedAttachments: () => [],
            getUnsupportedAttachmentMessage: () => null,
            getCurrentInputSnapshot: (query) =>
                createInputHistorySnapshot({ text: query, attachments: [] }),
        })
    );
}

async function openHistory(flow: Awaited<ReturnType<typeof mountFlow>>['result']) {
    await flow.setSessionHistoryPopupOpen(true);
    flow.beginHistoryInteraction();
    flow.reportHistoryInteractionOpened();
    await flow.ensureSessionListLoaded();
    await flushPromises();
}

describe('user selects conversation history', () => {
    let telemetry: ReturnType<typeof installProductAnalytics>;
    let rows: SessionEntity[];
    const pending = new Map<number, ReturnType<typeof deferred<ReturnType<typeof response>>>>();
    const unmounts: Array<() => void> = [];

    beforeEach(() => {
        telemetry = installProductAnalytics();
        rows = [session(7)];
        pending.clear();
        mockTauriCommand('database_query', (payload) => {
            const { request } = payload as {
                request: { sql: string; method: string; params: unknown[] };
            };
            if (request.sql.includes('from "sessions"')) {
                if (request.method === 'get') {
                    const id = Number(request.params.at(-1));
                    return pending.get(id)?.promise ?? response([session(id)]);
                }
                return response(rows);
            }
            return response();
        });
    });

    afterEach(() => {
        unmounts.forEach((unmount) => unmount());
        unmounts.length = 0;
    });

    async function flow() {
        const mounted = await mountFlow();
        unmounts.push(mounted.unmount);
        return mounted;
    }

    const completed = () =>
        telemetry.events.filter((event) => event.eventName === 'search.completed');
    const selected = () =>
        telemetry.events.filter((event) => event.eventName === 'search.result_selected');

    it('user gets the cached visible result count when closing prefetched history', async () => {
        const { result } = await flow();
        await result.ensureSessionListLoaded();
        await openHistory(result);
        await result.setSessionHistoryPopupOpen(false);
        await flushPromises();

        expect(completed()).toHaveLength(1);
        expect(completed()[0]?.attributes).toMatchObject({
            has_results: true,
            result_count_bucket: '1',
        });
        expect(selected()).toEqual([]);
        expect(telemetry.active.size).toBe(0);
    });

    it('user keeps two pending history selections tied to their own results when the first finishes first', async () => {
        const first = deferred<ReturnType<typeof response>>();
        const second = deferred<ReturnType<typeof response>>();
        pending.set(7, first);
        pending.set(8, second);
        const { result } = await flow();
        await openHistory(result);
        const selectionA = result.markHistorySelectionPending();
        await result.setSessionHistoryPopupOpen(false);
        const openingA = result.openSession(7, 'history', selectionA);

        rows = [session(8), session(9), session(10)];
        await openHistory(result);
        await result.refreshSessionList();
        const selectionB = result.markHistorySelectionPending();
        await result.setSessionHistoryPopupOpen(false);
        const openingB = result.openSession(8, 'history', selectionB);
        await flushPromises();
        expect(telemetry.released).toEqual([]);

        first.resolve(response([session(7)]));
        await expect(openingA).resolves.toMatchObject({ sessionId: 7 });
        await flushPromises();
        expect(selected().map((event) => event.operationId)).toEqual(['operation-1']);
        expect(telemetry.released).toEqual(['operation-1']);
        expect(telemetry.active.has('operation-2')).toBe(true);

        second.resolve(response([session(8)]));
        await expect(openingB).resolves.toMatchObject({ sessionId: 8 });
        await flushPromises();
        expect(completed().map((event) => event.attributes.result_count_bucket)).toEqual([
            '1',
            '2-5',
        ]);
        expect(selected().map((event) => [event.operationId, event.attributes.opened])).toEqual([
            ['operation-1', true],
            ['operation-2', true],
        ]);
        expect(selected().map((event) => event.attributes.interaction_id)).toEqual(
            completed().map((event) => event.attributes.interaction_id)
        );
        expect(telemetry.released).toEqual(['operation-1', 'operation-2']);
    });

    it('user keeps a failed older selection separate from a newer abandoned selection', async () => {
        const first = deferred<ReturnType<typeof response>>();
        pending.set(7, first);
        const { result } = await flow();
        await openHistory(result);
        const selectionA = result.markHistorySelectionPending();
        await result.setSessionHistoryPopupOpen(false);
        const openingA = result.openSession(7, 'history', selectionA);
        const failure = expect(openingA).rejects.toThrow();
        await openHistory(result);
        const selectionB = result.markHistorySelectionPending();
        await result.setSessionHistoryPopupOpen(false);
        result.abandonHistorySelection(selectionB);
        first.reject(new Error('history unavailable'));
        await failure;
        await flushPromises();

        expect(selected()).toEqual([
            expect.objectContaining({
                operationId: 'operation-1',
                attributes: expect.objectContaining({ opened: false }),
            }),
        ]);
        expect(new Set(telemetry.released)).toEqual(new Set(['operation-1', 'operation-2']));
        expect(telemetry.active.size).toBe(0);
    });

    it('user gets no history selection when another surface opens a conversation', async () => {
        const { result } = await flow();
        await openHistory(result);
        await result.openSession(7);
        await flushPromises();
        expect(selected()).toEqual([]);
        expect(telemetry.released).toEqual([]);
        await result.setSessionHistoryPopupOpen(false);
        await flushPromises();
        expect(telemetry.active.size).toBe(0);
    });

    it('user releases every pending selection on leaving the search page', async () => {
        const { result, unmount } = await mountFlow();
        await openHistory(result);
        const selectionA = result.markHistorySelectionPending();
        await result.setSessionHistoryPopupOpen(false);
        await openHistory(result);
        const selectionB = result.markHistorySelectionPending();
        unmount();
        await flushPromises();
        result.abandonHistorySelection(selectionA);
        result.abandonHistorySelection(selectionB);
        await flushPromises();
        expect(telemetry.released.sort()).toEqual(['operation-1', 'operation-2']);
        expect(selected()).toEqual([]);
    });
});
