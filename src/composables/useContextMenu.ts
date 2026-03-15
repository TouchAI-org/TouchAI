// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import ContextMenuVue from '@components/ContextMenu.vue';
import { type App, createApp, ref } from 'vue';

export interface ContextMenuItem {
    key: string;
    label: string;
    icon?: string;
    danger?: boolean;
}

export function useContextMenu<T = void>(
    items: ContextMenuItem[],
    onSelect: (key: string, context: T) => void
) {
    const context = ref<T | undefined>(undefined) as { value: T | undefined };
    let mountedApp: App | null = null;
    let container: HTMLDivElement | null = null;

    const cleanup = () => {
        if (mountedApp) {
            mountedApp.unmount();
            mountedApp = null;
        }
        if (container) {
            container.remove();
            container = null;
        }
    };

    const open = (event: MouseEvent, ctx?: T) => {
        event.preventDefault();
        cleanup();

        context.value = ctx;
        container = document.createElement('div');
        document.body.appendChild(container);

        mountedApp = createApp(ContextMenuVue, {
            x: event.clientX,
            y: event.clientY,
            items,
            onSelect: (key: string) => {
                if (context.value !== undefined) {
                    onSelect(key, context.value);
                }
                cleanup();
            },
            onClose: cleanup,
        });
        mountedApp.mount(container);
    };

    return { open };
}
