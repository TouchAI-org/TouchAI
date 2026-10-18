import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import SettingsWindowTitleBar from '@/views/SettingsView/components/SettingsWindowTitleBar.vue';

const windowApiMock = vi.hoisted(() => ({
    currentWindow: {
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        maximize: vi.fn().mockResolvedValue(undefined),
        minimize: vi.fn().mockResolvedValue(undefined),
        onResized: vi.fn(),
        unmaximize: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => windowApiMock.currentWindow,
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: { props: ['name'], template: '<span :data-name="name" />' },
}));

describe('SettingsWindowTitleBar', () => {
    beforeEach(() => {
        windowApiMock.currentWindow.isMaximized.mockReset().mockResolvedValue(false);
        windowApiMock.currentWindow.onResized.mockReset().mockResolvedValue(() => undefined);
    });

    it('reflects an already maximized window on mount', async () => {
        windowApiMock.currentWindow.isMaximized.mockResolvedValue(true);
        const wrapper = mount(SettingsWindowTitleBar);
        try {
            await flushPromises();
            expect(
                wrapper.get('[data-testid="settings-window-maximize"]').attributes('title')
            ).toBe('还原');
        } finally {
            wrapper.unmount();
        }
    });

    it('tracks external resize/maximize changes and releases its listener', async () => {
        const unlisten = vi.fn();
        let notifyResized: (() => void) | undefined;
        windowApiMock.currentWindow.onResized.mockImplementation((listener: () => void) => {
            notifyResized = listener;
            return Promise.resolve(unlisten);
        });

        const wrapper = mount(SettingsWindowTitleBar);
        await flushPromises();
        expect(wrapper.get('[data-testid="settings-window-maximize"]').attributes('title')).toBe(
            '最大化'
        );

        windowApiMock.currentWindow.isMaximized.mockResolvedValue(true);
        notifyResized?.();
        await flushPromises();
        expect(wrapper.get('[data-testid="settings-window-maximize"]').attributes('title')).toBe(
            '还原'
        );

        wrapper.unmount();
        expect(unlisten).toHaveBeenCalledOnce();
    });

    it('toggles maximization on a titlebar double-click', async () => {
        const wrapper = mount(SettingsWindowTitleBar);
        try {
            await flushPromises();
            await wrapper.get('[data-testid="settings-window-titlebar"]').trigger('dblclick');
            await flushPromises();
            expect(windowApiMock.currentWindow.maximize).toHaveBeenCalledOnce();

            windowApiMock.currentWindow.isMaximized.mockResolvedValue(true);
            await wrapper.get('[data-testid="settings-window-titlebar"]').trigger('dblclick');
            await flushPromises();
            expect(windowApiMock.currentWindow.unmaximize).toHaveBeenCalledOnce();
        } finally {
            wrapper.unmount();
        }
    });
});
