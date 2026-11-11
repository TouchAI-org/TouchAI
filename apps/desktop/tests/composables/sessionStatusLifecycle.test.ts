import { AppEvent, eventService } from '@services/EventService';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';

import { useSessionStatus } from '@/composables/useSessionStatus';

import { getTauriInvokeCalls, interceptTauriInvoke } from '../utils/tauri';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

let wrapper: VueWrapper | undefined;

function mountStatuses() {
    let statuses!: ReturnType<typeof useSessionStatus>;
    wrapper = mount(
        defineComponent({
            setup() {
                statuses = useSessionStatus();
                return () => h('span', statuses.getSessionStatus(7) ?? 'none');
            },
        })
    );
    return statuses;
}

async function broadcastStatus(status: 'running' | 'completed' = 'running') {
    await eventService.emit(AppEvent.SESSION_TASK_STATUS_CHANGED, {
        sessionId: 7,
        taskId: 'status-lifecycle',
        status,
        previousStatus: null,
        reminder: null,
    });
    await flushPromises();
}

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    await flushPromises();
});

describe('user observes session status within the view lifetime', () => {
    it('user receives active status and sees it removed when the session finishes', async () => {
        mountStatuses();
        await flushPromises();

        await broadcastStatus();
        expect(wrapper!.text()).toBe('running');
        await broadcastStatus('completed');

        expect(wrapper!.text()).toBe('none');
    });

    it('user leaves while native registration is pending and queued events cannot change the projection', async () => {
        const started = deferred();
        const registration = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'plugin:event|listen') {
                const result = await next();
                started.resolve();
                await registration.promise;
                return result;
            }
            return next();
        });
        const statuses = mountStatuses();
        await started.promise;

        wrapper!.unmount();
        await broadcastStatus();
        registration.resolve();
        await flushPromises();

        expect(statuses.getSessionStatus(7)).toBeUndefined();
        expect(getTauriInvokeCalls('plugin:event|unlisten')).toHaveLength(1);
    });

    it('user leaves while unregistration is pending and queued terminal events cannot change the projection', async () => {
        const unregistration = deferred();
        const statuses = mountStatuses();
        await flushPromises();
        await broadcastStatus();
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'plugin:event|unlisten') await unregistration.promise;
            return next();
        });

        wrapper!.unmount();
        await broadcastStatus('completed');
        unregistration.resolve();
        await flushPromises();

        expect(statuses.getSessionStatus(7)).toBe('running');
    });
});
