<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { UnlistenFn } from '@tauri-apps/api/event';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { onBeforeUnmount, onMounted, ref } from 'vue';

    import { t } from '@/i18n';

    const currentWindow = (() => {
        try {
            return getCurrentWindow();
        } catch {
            return null;
        }
    })();
    const isWindowMaximized = ref(false);
    let unlistenResized: UnlistenFn | null = null;
    let unmounted = false;
    let syncRevision = 0;

    const syncWindowMaximized = async () => {
        if (!currentWindow) return;
        const revision = ++syncRevision;
        try {
            const maximized = await currentWindow.isMaximized();
            if (!unmounted && revision === syncRevision) isWindowMaximized.value = maximized;
        } catch (error) {
            console.warn('[SettingsWindowTitleBar] Failed to read window state:', error);
        }
    };

    onMounted(() => {
        if (!currentWindow) return;
        void currentWindow
            .onResized(() => {
                void syncWindowMaximized();
            })
            .then((unlisten) => {
                if (unmounted) unlisten();
                else unlistenResized = unlisten;
                void syncWindowMaximized();
            })
            .catch((error) => {
                console.warn('[SettingsWindowTitleBar] Failed to listen for resize:', error);
                void syncWindowMaximized();
            });
    });

    onBeforeUnmount(() => {
        unmounted = true;
        unlistenResized?.();
    });

    const handleMinimize = async () => {
        await currentWindow?.minimize();
    };

    const handleToggleMaximize = async () => {
        if (!currentWindow) {
            return;
        }

        const maximized = await currentWindow.isMaximized();
        if (maximized) {
            await currentWindow.unmaximize();
            ++syncRevision;
            isWindowMaximized.value = false;
            return;
        }

        await currentWindow.maximize();
        ++syncRevision;
        isWindowMaximized.value = true;
    };

    const handleClose = async () => {
        await currentWindow?.close();
    };
</script>

<template>
    <header
        class="flex h-9 w-full shrink-0 items-center justify-end bg-[#f4f4f2] select-none"
        data-testid="settings-window-titlebar"
        data-tauri-drag-region
        @dblclick.self="handleToggleMaximize"
    >
        <div class="flex h-full items-center" data-testid="settings-window-controls">
            <button
                type="button"
                data-testid="settings-window-minimize"
                data-tauri-drag-region="false"
                class="flex h-full w-11 items-center justify-center text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900"
                :title="t('window.minimize')"
                :aria-label="t('window.minimize')"
                @click="handleMinimize"
            >
                <AppIcon name="minimize" class="h-3.5 w-3.5" />
            </button>

            <button
                type="button"
                data-testid="settings-window-maximize"
                data-tauri-drag-region="false"
                class="flex h-full w-11 items-center justify-center text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900"
                :title="isWindowMaximized ? t('window.restore') : t('window.maximize')"
                :aria-label="isWindowMaximized ? t('window.restore') : t('window.maximize')"
                @click="handleToggleMaximize"
            >
                <AppIcon
                    :name="isWindowMaximized ? 'restore-square' : 'maximize-square'"
                    class="h-3.5 w-3.5"
                    :class="isWindowMaximized ? '-scale-x-100' : ''"
                />
            </button>

            <button
                type="button"
                data-testid="settings-window-close"
                data-tauri-drag-region="false"
                class="flex h-full w-11 items-center justify-center text-neutral-500 transition-colors hover:bg-red-600 hover:text-white"
                :title="t('window.close')"
                :aria-label="t('window.close')"
                @click="handleClose"
            >
                <AppIcon name="close" class="h-3.5 w-3.5" />
            </button>
        </div>
    </header>
</template>
