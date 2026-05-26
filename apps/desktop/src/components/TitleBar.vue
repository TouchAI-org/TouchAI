<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { getCurrentWindow } from '@tauri-apps/api/window';

    interface Props {
        title?: string;
        showLogo?: boolean;
        showMinimize?: boolean;
        showMaximize?: boolean;
        showClose?: boolean;
    }

    withDefaults(defineProps<Props>(), {
        title: 'TouchAI',
        showLogo: true,
        showMinimize: true,
        showMaximize: false,
        showClose: true,
    });

    const currentWindow = (() => {
        try {
            return getCurrentWindow();
        } catch {
            return null;
        }
    })();

    const handleMinimize = async () => {
        await currentWindow?.minimize();
    };

    const handleClose = async () => {
        await currentWindow?.close();
    };
</script>

<template>
    <div
        class="flex h-10 w-full items-center justify-between bg-[#f7f7f6] px-4 select-none"
        data-testid="app-titlebar"
        data-tauri-drag-region
    >
        <div class="flex items-center gap-2" data-tauri-drag-region>
            <span class="text-sm font-medium text-neutral-900" data-tauri-drag-region>
                {{ title }}
            </span>
        </div>

        <div class="flex items-center gap-1">
            <button
                v-if="showMinimize"
                data-tauri-drag-region="false"
                class="flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600"
                title="最小化"
                @click="handleMinimize"
            >
                <AppIcon name="minimize" class="h-4 w-4" />
            </button>

            <button
                v-if="showClose"
                data-tauri-drag-region="false"
                class="flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                title="关闭"
                @click="handleClose"
            >
                <AppIcon name="close" class="h-4 w-4" />
            </button>
        </div>
    </div>
</template>
