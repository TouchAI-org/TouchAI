<!-- Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { AppIconName } from '@components/appIconMap';
    import { onMounted, onUnmounted } from 'vue';

    import { log } from '@/app/api/diagnostics';
    import { useTrayWindowApi } from '@/app/api/windows/presentation';
    import { type MessageKey, t } from '@/i18n';

    defineOptions({
        name: 'TrayMenuView',
    });

    interface MenuItem {
        id: string;
        icon: AppIconName;
        labelKey: MessageKey;
        action: () => void;
    }

    const menuItems: MenuItem[] = [
        {
            id: 'show-window',
            icon: 'search',
            labelKey: 'tray.show',
            action: showMainWindow,
        },
        {
            id: 'settings',
            icon: 'settings',
            labelKey: 'tray.settings',
            action: openSettings,
        },
        {
            id: 'quit',
            icon: 'x-circle',
            labelKey: 'tray.exit',
            action: quitApp,
        },
    ];
    const tray = useTrayWindowApi();
    let disposed = false;
    let pointerInsideMenu = false;
    let unlistenBlur: (() => void) | null = null;

    onMounted(async () => {
        try {
            const stop = await tray.onBlur(() => {
                if (!pointerInsideMenu) void closeTrayMenu();
            });
            if (disposed) stop();
            else unlistenBlur = stop;
        } catch (error) {
            log.error('[TrayMenu] Failed to setup focus listener:', error);
        }
    });

    onUnmounted(() => {
        disposed = true;
        unlistenBlur?.();
        unlistenBlur = null;
        void closeTrayMenu();
    });

    if (import.meta.hot) {
        import.meta.hot.dispose(() => {
            void closeTrayMenu();
        });
    }

    async function showMainWindow() {
        try {
            await tray.showSearch();
        } catch (error) {
            log.error('[TrayMenu] Error showing main window:', error);
        }

        closeTrayMenu().then(() => {});
    }

    async function openSettings() {
        try {
            try {
                await tray.openSettings();
            } catch (error) {
                log.error('Failed to open settings:', error);
            }

            closeTrayMenu().then();
        } catch (error) {
            log.error('Failed to open settings:', error);
        }
    }

    async function quitApp() {
        try {
            await tray.quit();
        } catch (error) {
            log.error('Failed to quit app:', error);
        }

        closeTrayMenu().then();
    }

    async function closeTrayMenu() {
        try {
            await tray.closeMenu();
        } catch (error) {
            log.error('Failed to close tray menu:', error);
        }
    }

    function handlePointerEnter() {
        pointerInsideMenu = true;
    }

    function handlePointerLeave() {
        pointerInsideMenu = false;
        if (!document.hasFocus()) void closeTrayMenu();
    }
</script>

<template>
    <div
        class="tray-menu-container flex h-full w-full flex-col rounded-window border border-window-border bg-white/95 shadow-lg backdrop-blur-sm"
        @pointerenter="handlePointerEnter"
        @pointerleave="handlePointerLeave"
    >
        <div
            v-for="(item, index) in menuItems"
            :key="item.id"
            :class="[
                'flex cursor-pointer items-center gap-3 px-4 py-3 font-serif text-sm text-gray-700 transition-colors',
                'hover:bg-primary-50 hover:text-primary-700',
                index === 0 ? 'rounded-t-window' : '',
                index === menuItems.length - 1 ? 'rounded-b-window' : 'border-b border-gray-100',
            ]"
            @click="item.action()"
        >
            <AppIcon :name="item.icon" class="h-4 w-4" />
            <span>{{ t(item.labelKey) }}</span>
        </div>
    </div>
</template>
