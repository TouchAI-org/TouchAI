import { AppEvent, eventService } from '@services/EventService';
import { getTauriInvokeCalls, interceptTauriInvoke, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, disposePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import { createInputHistorySnapshot } from '@/types/session';
import { useSearchRequestFlow } from '@/views/SearchView/composables/useSearchRequest';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

let wrapper: VueWrapper | undefined;
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
    pinia = createPinia();
    mockTauriCommand('database_query', { rows: [], rowsAffected: 0, lastInsertId: null });
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    disposePinia(pinia);
    await flushPromises();
});

function mountHistory() {
    let history!: ReturnType<typeof useSearchRequestFlow>;
    wrapper = mount(
        defineComponent({
            setup() {
                history = useSearchRequestFlow({
                    modelOverride: ref({ modelId: null, providerId: null }),
                    clearDraft: () => undefined,
                    getSupportedAttachments: () => [],
                    getUnsupportedAttachmentMessage: () => null,
                    getCurrentInputSnapshot: (text) =>
                        createInputHistorySnapshot({ text, attachments: [] }),
                });
                return () =>
                    h('span', history.sessionList.value.map((session) => session.title).join(','));
            },
        }),
        { global: { plugins: [pinia] } }
    );
    return history;
}

async function broadcastCompletion() {
    await eventService.emit(AppEvent.SESSION_TASK_STATUS_CHANGED, {
        sessionId: 7,
        taskId: 'history-lifecycle',
        status: 'completed',
        previousStatus: 'running',
        reminder: null,
    });
    await flushPromises();
}

describe('user observes history only while the search view is mounted', () => {
    it('user leaves during subscription registration and a late completion cannot reload abandoned history', async () => {
        const started = deferred();
        const registration = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (
                call.cmd === 'plugin:event|listen' &&
                (call.payload as { event?: string })?.event === AppEvent.SESSION_TASK_STATUS_CHANGED
            ) {
                const result = await next();
                started.resolve();
                await registration.promise;
                return result;
            }
            return next();
        });
        const history = mountHistory();
        await started.promise;
        await history.setSessionHistoryOverlayOpen(true);
        await history.ensureSessionListLoaded();
        const readsBeforeLeaving = getTauriInvokeCalls('database_query').length;

        wrapper!.unmount();
        await broadcastCompletion();
        registration.resolve();
        await flushPromises();

        expect(getTauriInvokeCalls('database_query')).toHaveLength(readsBeforeLeaving);
        expect(getTauriInvokeCalls('plugin:event|unlisten')).toHaveLength(1);
    });

    it('user leaves during subscription cleanup and a queued completion cannot restart history loading', async () => {
        const history = mountHistory();
        await flushPromises();
        await history.setSessionHistoryOverlayOpen(true);
        await history.ensureSessionListLoaded();
        const readsBeforeLeaving = getTauriInvokeCalls('database_query').length;
        const unregistration = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'plugin:event|unlisten') await unregistration.promise;
            return next();
        });

        wrapper!.unmount();
        await broadcastCompletion();
        unregistration.resolve();
        await flushPromises();

        expect(getTauriInvokeCalls('database_query')).toHaveLength(readsBeforeLeaving);
        expect(history.isSessionListLoading.value).toBe(false);
    });
});
