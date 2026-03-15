// Copyright (c) 2026. 千诚. Licensed under GPL v3

import ConfirmDialogVue from '@components/ConfirmDialog.vue';
import { type App, createApp } from 'vue';

export interface ConfirmOptions {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: 'warning' | 'danger' | 'info';
}

export function useConfirm() {
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

    const confirm = (options: ConfirmOptions): Promise<boolean> => {
        cleanup();

        return new Promise((resolve) => {
            container = document.createElement('div');
            document.body.appendChild(container);

            mountedApp = createApp(ConfirmDialogVue, {
                title: options.title,
                message: options.message,
                confirmText: options.confirmText,
                cancelText: options.cancelText,
                type: options.type,
                onConfirm: () => {
                    resolve(true);
                    cleanup();
                },
                onCancel: () => {
                    resolve(false);
                    cleanup();
                },
            });
            mountedApp.mount(container);
        });
    };

    return { confirm };
}
