import { shallowMount } from '@vue/test-utils';
import { vi } from 'vitest';

import TitleBar from '@/components/TitleBar.vue';

const windowApiMock = vi.hoisted(() => ({
    currentWindow: {
        minimize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
    },
    shouldThrow: false,
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => {
        if (windowApiMock.shouldThrow) {
            throw new Error('Tauri window metadata is unavailable');
        }

        return windowApiMock.currentWindow;
    },
}));

describe('TitleBar', () => {
    beforeEach(() => {
        windowApiMock.shouldThrow = false;
        windowApiMock.currentWindow.minimize.mockClear();
        windowApiMock.currentWindow.close.mockClear();
    });

    it('renders in a browser-only dev session when Tauri window metadata is unavailable', async () => {
        windowApiMock.shouldThrow = true;

        const wrapper = shallowMount(TitleBar, {
            props: {
                title: '设置',
            },
        });

        expect(wrapper.text()).toContain('设置');

        await wrapper.get('button[title="最小化"]').trigger('click');
        await wrapper.get('button[title="关闭"]').trigger('click');

        expect(windowApiMock.currentWindow.minimize).not.toHaveBeenCalled();
        expect(windowApiMock.currentWindow.close).not.toHaveBeenCalled();
    });

    it('uses the Tauri window controls when available', async () => {
        const wrapper = shallowMount(TitleBar);

        await wrapper.get('button[title="最小化"]').trigger('click');
        await wrapper.get('button[title="关闭"]').trigger('click');

        expect(windowApiMock.currentWindow.minimize).toHaveBeenCalledTimes(1);
        expect(windowApiMock.currentWindow.close).toHaveBeenCalledTimes(1);
    });
});
