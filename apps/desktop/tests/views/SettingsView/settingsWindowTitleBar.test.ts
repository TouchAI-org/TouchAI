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

describe('user controls the settings window', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        windowApiMock.currentWindow.isMaximized.mockReset().mockResolvedValue(false);
        windowApiMock.currentWindow.onResized.mockReset().mockResolvedValue(() => undefined);
    });

    it('user reflects an already maximized window on mount', async () => {
        windowApiMock.currentWindow.isMaximized.mockResolvedValue(true);
        const wrapper = mount(SettingsWindowTitleBar);
        try {
            await flushPromises();
            // ui/Tooltip 取代了原生 title，可访问名改由 aria-label 提供
            expect(
                wrapper.get('[data-testid="settings-window-maximize"]').attributes('aria-label')
            ).toBe('还原');
        } finally {
            wrapper.unmount();
        }
    });

    it('user tracks external resize/maximize changes and releases its listener', async () => {
        const unlisten = vi.fn();
        let notifyResized: (() => void) | undefined;
        windowApiMock.currentWindow.onResized.mockImplementation((listener: () => void) => {
            notifyResized = listener;
            return Promise.resolve(unlisten);
        });

        const wrapper = mount(SettingsWindowTitleBar);
        await flushPromises();
        expect(
            wrapper.get('[data-testid="settings-window-maximize"]').attributes('aria-label')
        ).toBe('最大化');

        windowApiMock.currentWindow.isMaximized.mockResolvedValue(true);
        notifyResized?.();
        await flushPromises();
        expect(
            wrapper.get('[data-testid="settings-window-maximize"]').attributes('aria-label')
        ).toBe('还原');

        wrapper.unmount();
        expect(unlisten).toHaveBeenCalledOnce();
    });

    it('user leaves titlebar double-click maximization to the native drag region', async () => {
        const wrapper = mount(SettingsWindowTitleBar);
        try {
            await flushPromises();
            const titlebar = wrapper.get('[data-testid="settings-window-titlebar"]');
            expect(titlebar.attributes('data-tauri-drag-region')).toBe('');

            await titlebar.trigger('dblclick');
            await flushPromises();

            expect(windowApiMock.currentWindow.maximize).not.toHaveBeenCalled();
            expect(windowApiMock.currentWindow.unmaximize).not.toHaveBeenCalled();
        } finally {
            wrapper.unmount();
        }
    });

    it('user toggles maximization from the explicit window control', async () => {
        const wrapper = mount(SettingsWindowTitleBar);
        try {
            await flushPromises();
            expect(
                wrapper.get('[data-testid="settings-window-maximize"]').attributes('aria-label')
            ).toBe('最大化');

            await wrapper.get('[data-testid="settings-window-maximize"]').trigger('click');
            await flushPromises();
            expect(windowApiMock.currentWindow.maximize).toHaveBeenCalledOnce();
            // The control now offers the opposite action.
            expect(
                wrapper.get('[data-testid="settings-window-maximize"]').attributes('aria-label')
            ).toBe('还原');

            windowApiMock.currentWindow.isMaximized.mockResolvedValue(true);
            await wrapper.get('[data-testid="settings-window-maximize"]').trigger('click');
            await flushPromises();
            expect(windowApiMock.currentWindow.unmaximize).toHaveBeenCalledOnce();
        } finally {
            wrapper.unmount();
        }
    });

    it('user still gets the titlebar when the window state cannot be read', async () => {
        windowApiMock.currentWindow.isMaximized.mockRejectedValue(new Error('window gone'));

        const wrapper = mount(SettingsWindowTitleBar);
        try {
            await flushPromises();

            expect(
                wrapper.get('[data-testid="settings-window-maximize"]').attributes('aria-label')
            ).toBe('最大化');
        } finally {
            wrapper.unmount();
        }
    });

    it('user still gets the titlebar when resize events cannot be observed', async () => {
        windowApiMock.currentWindow.onResized.mockRejectedValue(new Error('listener unavailable'));

        const wrapper = mount(SettingsWindowTitleBar);
        try {
            await flushPromises();

            expect(
                wrapper.get('[data-testid="settings-window-maximize"]').attributes('aria-label')
            ).toBe('最大化');
        } finally {
            wrapper.unmount();
        }
    });
});
