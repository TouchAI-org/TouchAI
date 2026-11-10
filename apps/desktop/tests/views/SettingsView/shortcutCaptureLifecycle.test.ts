import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';

import { AppEvent, eventService } from '@/services/EventService';
import { useSystemKeyCaptureSubscription } from '@/views/SettingsView/composables/useShortcutCapture';

import { getLastTauriInvokeCall, interceptTauriInvoke } from '../../utils/tauri';

enableAutoUnmount(afterEach);

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

function mountCapture() {
    const keys: string[] = [];
    const errors: unknown[] = [];
    const wrapper = mount(
        defineComponent({
            setup() {
                useSystemKeyCaptureSubscription(
                    (event) => keys.push(event.key),
                    (error) => errors.push(error)
                );
                return () => h('div');
            },
        })
    );
    return { wrapper, keys, errors };
}

async function pressSystemKey() {
    await eventService.emit(AppEvent.SHORTCUT_CAPTURE_SYSTEM_KEY, {
        key: 'Space',
        ctrl: false,
        alt: true,
        shift: false,
    });
}

describe('user records shortcuts while native registration is asynchronous', () => {
    it('user receives keys while the recording page is mounted', async () => {
        const { keys } = mountCapture();
        await flushPromises();

        await pressSystemKey();

        expect(keys).toEqual(['Space']);
    });

    it('user leaves before registration finishes and no stale recording remains', async () => {
        const registration = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'plugin:event|listen') await registration.promise;
            return next();
        });
        const { wrapper, keys } = mountCapture();

        wrapper.unmount();
        registration.resolve();
        await flushPromises();
        await pressSystemKey();

        expect(keys).toEqual([]);
        expect(getLastTauriInvokeCall('plugin:event|unlisten')?.payload).toMatchObject({
            event: AppEvent.SHORTCUT_CAPTURE_SYSTEM_KEY,
        });
    });

    it('user leaves and queued keys are ignored while native unregistration is pending', async () => {
        const unregistration = deferred();
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'plugin:event|unlisten') await unregistration.promise;
            return next();
        });
        const { wrapper, keys } = mountCapture();
        await flushPromises();

        wrapper.unmount();
        await pressSystemKey();
        unregistration.resolve();
        await flushPromises();

        expect(keys).toEqual([]);
    });

    it('user can record on a new page after registration failed on the previous page', async () => {
        const failure = new Error('Native event registration failed');
        let rejectRegistration = true;
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'plugin:event|listen' && rejectRegistration) throw failure;
            return next();
        });
        const first = mountCapture();
        await flushPromises();
        first.wrapper.unmount();
        rejectRegistration = false;

        const second = mountCapture();
        await flushPromises();
        await pressSystemKey();

        expect(first.errors).toEqual([failure]);
        expect(first.keys).toEqual([]);
        expect(second.keys).toEqual(['Space']);
        expect(second.errors).toEqual([]);
    });
});
