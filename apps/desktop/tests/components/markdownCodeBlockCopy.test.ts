import MarkdownContent from '@components/MarkdownContent.vue';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';

import { deferred, installProductAnalytics } from '../utils/productAnalytics';

vi.mock('@tauri-apps/plugin-notification', () => ({
    sendNotification: vi.fn(),
    isPermissionGranted: vi.fn(),
    requestPermission: vi.fn(),
}));

describe('user copies a rendered code block', () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let telemetry: ReturnType<typeof installProductAnalytics>;
    const wrappers: ReturnType<typeof mount>[] = [];

    beforeEach(() => {
        vi.clearAllMocks();
        telemetry = installProductAnalytics();
        setLocale('en-US');
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            }
        );
    });

    afterEach(() => {
        wrappers.forEach((wrapper) => wrapper.unmount());
        wrappers.length = 0;
        vi.unstubAllGlobals();
        if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
        else Reflect.deleteProperty(navigator, 'clipboard');
    });

    async function renderCode() {
        const wrapper = mount(MarkdownContent, {
            props: { content: '```text\nprivate code\n```', final: true },
            attachTo: document.body,
        });
        wrappers.push(wrapper);
        await vi.dynamicImportSettled();
        await flushPromises();
        return wrapper;
    }

    function clipboard(writeText?: (value: string) => Promise<void>) {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: writeText ? { writeText } : undefined,
        });
    }

    it('user sees a successful copy only after a delayed clipboard write finishes', async () => {
        const write = deferred<void>();
        const writeText = vi.fn(() => write.promise);
        clipboard(writeText);
        const wrapper = await renderCode();

        await wrapper.get('button[aria-label="Copy"]').trigger('click');
        await flushPromises();
        expect(writeText).toHaveBeenCalledWith('private code\n');
        expect(sendNotification).not.toHaveBeenCalled();
        expect(telemetry.events).toEqual([]);
        expect(telemetry.active.size).toBe(1);

        write.resolve();
        await flushPromises();
        expect(telemetry.events).toEqual([
            expect.objectContaining({
                eventName: 'result.action_completed',
                operationId: 'operation-1',
                attributes: expect.objectContaining({ action: 'copy_code', result: 'success' }),
            }),
        ]);
        expect(telemetry.released).toEqual(['operation-1']);
        expect(sendNotification).toHaveBeenCalledWith({ title: 'TouchAI', body: 'Copied' });
    });

    it('user sees a copy failure when the clipboard rejects the write', async () => {
        const write = deferred<void>();
        clipboard(() => write.promise);
        const wrapper = await renderCode();
        await wrapper.get('button[aria-label="Copy"]').trigger('click');

        write.reject(new Error('clipboard denied'));
        await flushPromises();
        expect(telemetry.events[0]?.attributes).toMatchObject({
            action: 'copy_code',
            result: 'failure',
        });
        expect(telemetry.active.size).toBe(0);
        expect(sendNotification).toHaveBeenCalledWith({ title: 'TouchAI', body: 'Copy failed' });
    });

    it('user sees a copy failure when the browser clipboard API is missing', async () => {
        clipboard();
        const wrapper = await renderCode();
        await wrapper.get('button[aria-label="Copy"]').trigger('click');
        await flushPromises();

        expect(telemetry.events[0]?.attributes.result).toBe('failure');
        expect(telemetry.released).toEqual(['operation-1']);
        expect(sendNotification).toHaveBeenCalledWith({ title: 'TouchAI', body: 'Copy failed' });
    });

    it('user can collapse a rendered block and still copy its original code', async () => {
        const writeText = vi.fn(async () => undefined);
        clipboard(writeText);
        const wrapper = await renderCode();
        const collapse = wrapper.get('button[aria-pressed]');
        expect(collapse.attributes('aria-pressed')).toBe('false');
        await collapse.trigger('click');
        expect(collapse.attributes('aria-pressed')).toBe('true');

        await wrapper.get('button[aria-label="Copy"]').trigger('click');
        await flushPromises();
        expect(writeText).toHaveBeenCalledWith('private code\n');
        expect(telemetry.events[0]?.attributes.result).toBe('success');
        expect(wrapper.findAll('[role="status"]').map((status) => status.text())).toContain(
            'Copied'
        );
    });

    it.each(['disabled at copy start', 'revoked while the write is pending'] as const)(
        'user completes the copy without telemetry after consent is enabled again if consent was %s',
        async (initial) => {
            if (initial === 'disabled at copy start') telemetry.setEnabled(false);
            const write = deferred<void>();
            clipboard(() => write.promise);
            const wrapper = await renderCode();
            await wrapper.get('button[aria-label="Copy"]').trigger('click');
            await flushPromises();

            telemetry.setEnabled(false);
            telemetry.setEnabled(true);
            write.resolve();
            await flushPromises();

            expect(telemetry.events).toEqual([]);
            expect(telemetry.released).toEqual(['operation-1']);
            expect(sendNotification).toHaveBeenCalledWith({ title: 'TouchAI', body: 'Copied' });
        }
    );
});
