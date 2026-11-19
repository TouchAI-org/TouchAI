import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { mountComposable } from '@tests/utils/composables';
import { deferred, installProductAnalytics } from '@tests/utils/productAnalytics';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { agentApiKey } from '@/app/api/agent';
import { createInputHistorySnapshot } from '@/app/api/agent/history';
import { productAnalyticsApiKey } from '@/app/api/analytics/product';
import { settingsApiKey } from '@/app/api/settings/preferences';
import { useSearchRequestFlow } from '@/views/SearchView/composables/useSearchRequest';

let fixture: ReturnType<typeof createAgentWindowFixture>;
function insertSession(id: number) {
    fixture.database
        .prepare(
            'INSERT INTO sessions (id, session_id, title, model, provider_id) VALUES (?, ?, ?, ?, 1)'
        )
        .run(id, `session-${id}`, `Session ${id}`, 'fixture-model');
}

async function mountFlow() {
    return mountComposable(
        () =>
            useSearchRequestFlow({
                modelOverride: ref({ modelId: null, providerId: null }),
                clearDraft: () => undefined,
                getSupportedAttachments: () => [],
                getUnsupportedAttachmentMessage: () => null,
                getCurrentInputSnapshot: (query) =>
                    createInputHistorySnapshot({ text: query, attachments: [] }),
            }),
        (app) => {
            app.provide(agentApiKey, fixture.window.api);
            app.provide(settingsApiKey, fixture.window.settings);
            app.provide(productAnalyticsApiKey, fixture.window.productAnalytics);
        }
    );
}

async function openHistory(flow: Awaited<ReturnType<typeof mountFlow>>['result']) {
    await flow.setSessionHistoryOverlayOpen(true);
    flow.beginHistoryInteraction();
    flow.reportHistoryInteractionOpened();
    await flow.ensureSessionListLoaded();
    await flushPromises();
}

describe('user selects conversation history', () => {
    let telemetry: ReturnType<typeof installProductAnalytics>;
    const pending = new Map<number, ReturnType<typeof deferred<void>>>();
    const unmounts: Array<() => void> = [];

    beforeEach(async () => {
        telemetry = installProductAnalytics();
        pending.clear();
        fixture = createAgentWindowFixture('main', undefined, {
            beforeQuery: async (request) => {
                if (request.method === 'get' && request.sql.includes('from "sessions"')) {
                    const id = Number(request.params[request.params.length - 1]);
                    await pending.get(id)?.promise;
                }
            },
        });
        await fixture.window.ready;
        insertSession(7);
    });

    afterEach(async () => {
        unmounts.forEach((unmount) => unmount());
        unmounts.length = 0;
        await fixture.window.dispose();
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
        await result.setSessionHistoryOverlayOpen(false);
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
        const first = deferred<void>();
        const second = deferred<void>();
        pending.set(7, first);
        pending.set(8, second);
        const { result } = await flow();
        await openHistory(result);
        const selectionA = result.markHistorySelectionPending();
        await result.setSessionHistoryOverlayOpen(false);
        const openingA = result.openSession(7, 'history', selectionA);

        [8, 9, 10].forEach(insertSession);
        await openHistory(result);
        await result.refreshSessionList();
        const selectionB = result.markHistorySelectionPending();
        await result.setSessionHistoryOverlayOpen(false);
        const openingB = result.openSession(8, 'history', selectionB);
        await flushPromises();
        expect(telemetry.released).toEqual([]);

        first.resolve();
        await expect(openingA).resolves.toMatchObject({ sessionId: 7 });
        await flushPromises();
        expect(selected().map((event) => event.operationId)).toEqual(['operation-1']);
        expect(telemetry.released).toEqual(['operation-1']);
        expect(telemetry.active.has('operation-2')).toBe(true);

        second.resolve();
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
        const first = deferred<void>();
        pending.set(7, first);
        const { result } = await flow();
        await openHistory(result);
        const selectionA = result.markHistorySelectionPending();
        await result.setSessionHistoryOverlayOpen(false);
        const openingA = result.openSession(7, 'history', selectionA);
        const failure = expect(openingA).rejects.toThrow();
        await openHistory(result);
        const selectionB = result.markHistorySelectionPending();
        await result.setSessionHistoryOverlayOpen(false);
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
        await result.setSessionHistoryOverlayOpen(false);
        await flushPromises();
        expect(telemetry.active.size).toBe(0);
    });

    it('user releases every pending selection on leaving the search page', async () => {
        const { result, unmount } = await mountFlow();
        await openHistory(result);
        const selectionA = result.markHistorySelectionPending();
        await result.setSessionHistoryOverlayOpen(false);
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
