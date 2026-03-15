<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { getCurrentWindow } from '@tauri-apps/api/window';

    import SvgIcon from './SvgIcon.vue';

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

    const currentWindow = getCurrentWindow();

    const handleMinimize = async () => {
        await currentWindow.minimize();
    };

    const handleClose = async () => {
        await currentWindow.close();
    };
</script>

<template>
    <div
        class="flex h-10 w-full items-center justify-between border-b border-gray-200 bg-white px-4 select-none"
        data-tauri-drag-region
    >
        <div class="flex items-center gap-2" data-tauri-drag-region>
            <span class="font-serif text-sm font-medium text-gray-900" data-tauri-drag-region>
                {{ title }}
            </span>
        </div>

        <div class="flex items-center gap-1">
            <button
                v-if="showMinimize"
                data-tauri-drag-region="false"
                class="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                title="最小化"
                @click="handleMinimize"
            >
                <SvgIcon name="minimize" class="h-4 w-4" />
            </button>

            <button
                v-if="showClose"
                data-tauri-drag-region="false"
                class="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                title="关闭"
                @click="handleClose"
            >
                <SvgIcon name="close" class="h-4 w-4" />
            </button>
        </div>
    </div>
</template>
