import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type TrayWindowApi, trayWindowApiKey } from '@/app/api/windows/presentation';
import TrayView from '@/views/TrayView/index.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

function mountTrayMenu() {
    const closeMenu = vi.fn(async () => {});
    let blurListener: (() => void) | null = null;
    const tray: TrayWindowApi = {
        showSearch: vi.fn(async () => {}),
        openSettings: vi.fn(async () => {}),
        quit: vi.fn(async () => {}),
        closeMenu,
        onBlur: async (listener) => {
            blurListener = listener;
            return () => {
                blurListener = null;
            };
        },
    };
    const wrapper = mount(TrayView, {
        global: {
            provide: {
                [trayWindowApiKey as symbol]: tray,
            },
        },
    });
    return {
        wrapper,
        closeMenu,
        async ready() {
            await flushPromises();
        },
        loseFocus() {
            blurListener?.();
        },
        menu() {
            return wrapper.find('.tray-menu-container');
        },
    };
}

describe('user opens the tray menu', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('user sees the menu stay open when the pointer is over it as the window loses focus', async () => {
        const tray = mountTrayMenu();
        await tray.ready();
        await tray.menu().trigger('pointerenter');

        tray.loseFocus();
        await flushPromises();

        expect(tray.closeMenu).not.toHaveBeenCalled();
    });

    it('user sees the menu close when the window loses focus with the pointer outside it', async () => {
        const tray = mountTrayMenu();
        await tray.ready();

        tray.loseFocus();
        await flushPromises();

        expect(tray.closeMenu).toHaveBeenCalledTimes(1);
    });

    it('user sees the menu close when the pointer leaves after the window lost focus', async () => {
        const tray = mountTrayMenu();
        await tray.ready();
        await tray.menu().trigger('pointerenter');
        tray.loseFocus();
        await flushPromises();
        expect(tray.closeMenu).not.toHaveBeenCalled();

        vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        await tray.menu().trigger('pointerleave');

        expect(tray.closeMenu).toHaveBeenCalledTimes(1);
    });

    it('user sees the menu stay open when the pointer leaves while the window still has focus', async () => {
        const tray = mountTrayMenu();
        await tray.ready();
        await tray.menu().trigger('pointerenter');

        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        await tray.menu().trigger('pointerleave');

        expect(tray.closeMenu).not.toHaveBeenCalled();
    });
});
