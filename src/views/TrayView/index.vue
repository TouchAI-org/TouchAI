<!-- Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';
    import { native } from '@services/NativeService';
    import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
    import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
    import { exit } from '@tauri-apps/plugin-process';
    import { onMounted } from 'vue';

    defineOptions({
        name: 'TrayMenuView',
    });

    interface MenuItem {
        id: string;
        icon: string;
        label: string;
        action: () => void;
    }

    const menuItems: MenuItem[] = [
        {
            id: 'show-window',
            icon: 'search',
            label: '显示窗口',
            action: showMainWindow,
        },
        {
            id: 'settings',
            icon: 'settings',
            label: '设置',
            action: openSettings,
        },
        {
            id: 'quit',
            icon: 'x-circle',
            label: '退出',
            action: quitApp,
        },
    ];

    onMounted(async () => {
        try {
            await getCurrentWebviewWindow().listen('tauri://blur', () => {
                closeTrayMenu();
            });
        } catch (error) {
            console.error('[TrayMenu] Failed to setup focus listener:', error);
        }
    });

    async function showMainWindow() {
        try {
            const mainWindow = await WebviewWindow.getByLabel('main');

            if (mainWindow) {
                mainWindow.show().then(mainWindow.setFocus);
            }
        } catch (error) {
            console.error('[TrayMenu] Error showing main window:', error);
        }

        closeTrayMenu().then(() => {});
    }

    async function openSettings() {
        try {
            try {
                native.window.openSettingsWindow().then();
            } catch (error) {
                console.error('Failed to open settings:', error);
            }

            closeTrayMenu().then();
        } catch (error) {
            console.error('Failed to open settings:', error);
        }
    }

    async function quitApp() {
        try {
            await exit(0);
        } catch (error) {
            console.error('Failed to quit app:', error);
        }

        closeTrayMenu().then();
    }

    async function closeTrayMenu() {
        try {
            native.window.closeTrayMenu().then();
        } catch (error) {
            console.error('Failed to close tray menu:', error);
        }
    }
</script>

<template>
    <div
        class="tray-menu-container flex h-full w-full flex-col rounded-lg border border-gray-200 bg-white/95 shadow-lg backdrop-blur-sm"
    >
        <div
            v-for="(item, index) in menuItems"
            :key="item.id"
            :class="[
                'flex cursor-pointer items-center gap-3 px-4 py-3 font-serif text-sm text-gray-700 transition-colors',
                'hover:bg-primary-50 hover:text-primary-700',
                index === 0 ? 'rounded-t-lg' : '',
                index === menuItems.length - 1 ? 'rounded-b-lg' : 'border-b border-gray-100',
            ]"
            @click="item.action()"
        >
            <SvgIcon :name="item.icon" class="h-4 w-4" />
            <span>{{ item.label }}</span>
        </div>
    </div>
</template>

<style scoped></style>
