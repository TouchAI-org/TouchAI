// Copyright (c) 2026. 千诚. Licensed under GPL v3

import ConfirmDialogVue from '@components/ConfirmDialog.vue';
import { type App, createApp, onScopeDispose } from 'vue';

export interface ConfirmOptions {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: 'warning' | 'danger' | 'info';
}

export function useConfirm() {
    const cleanupGraceMs = 600;
    type ConfirmInstance = {
        app: App | null;
        container: HTMLDivElement;
        resolve: (value: boolean) => void;
        settled: boolean;
        cleanupTimer: ReturnType<typeof setTimeout> | null;
    };

    let active: ConfirmInstance | null = null;

    const dispose = (instance: ConfirmInstance) => {
        if (instance.cleanupTimer !== null) {
            clearTimeout(instance.cleanupTimer);
            instance.cleanupTimer = null;
        }
        instance.app?.unmount();
        instance.app = null;
        instance.container.remove();
        if (active === instance) active = null;
    };

    const scheduleDispose = (instance: ConfirmInstance) => {
        if (instance.cleanupTimer !== null) return;
        instance.cleanupTimer = setTimeout(() => dispose(instance), cleanupGraceMs);
    };

    const settle = (instance: ConfirmInstance, result: boolean) => {
        if (!instance.settled) {
            instance.settled = true;
            instance.resolve(result);
        }
        // The result is deliberately resolved immediately; visual disposal is
        // deferred until the shared modal exit animation completes (or the
        // timeout handles reduced-motion, tests, and interrupted animations).
        scheduleDispose(instance);
    };

    const confirm = (options: ConfirmOptions): Promise<boolean> => {
        if (active) {
            // A second request replaces the first one. Never leave its Promise
            // pending, and do not let its late animation event dispose the new
            // dialog because every callback closes over its own instance.
            const previous = active;
            if (!previous.settled) {
                previous.settled = true;
                previous.resolve(false);
            }
            dispose(previous);
        }

        return new Promise((resolve, reject) => {
            const container = document.createElement('div');
            document.body.appendChild(container);
            const instance: ConfirmInstance = {
                app: null,
                container,
                resolve,
                settled: false,
                cleanupTimer: null,
            };
            active = instance;

            instance.app = createApp(ConfirmDialogVue, {
                title: options.title,
                message: options.message,
                confirmText: options.confirmText,
                cancelText: options.cancelText,
                type: options.type,
                onConfirm: () => settle(instance, true),
                onCancel: () => settle(instance, false),
                onClosed: () => dispose(instance),
            });
            try {
                instance.app.mount(container);
            } catch (error) {
                dispose(instance);
                reject(error);
            }
        });
    };

    onScopeDispose(() => {
        if (!active) return;
        if (!active.settled) {
            active.settled = true;
            active.resolve(false);
        }
        dispose(active);
    });

    return { confirm };
}
