<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { PopupDataPayload, PopupType } from '@services/popup';
    import { initializeBuiltInPopups, popupRegistry } from '@services/popup';
    import { emit, listen } from '@tauri-apps/api/event';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';

    const popupType = ref<PopupType | null>(null);
    const popupData = shallowRef<unknown>(null);
    const componentRef = ref<{ handleKeyDown?: (e: KeyboardEvent) => void } | null>(null);
    const unlisteners: (() => void)[] = [];

    const popupComponent = computed(() =>
        popupType.value ? popupRegistry.get(popupType.value)?.component : null
    );

    async function close() {
        await emit('popup-closed', {});
        await getCurrentWindow().hide();
    }

    function handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') close();
    }

    onMounted(async () => {
        // 初始化内置弹窗注册表（PopupView 有独立的 JS 上下文）
        initializeBuiltInPopups();

        // 从 URL 获取类型
        const type = new URLSearchParams(window.location.search).get('type') as PopupType;
        popupType.value = type;

        const currentLabel = getCurrentWindow().label;

        // 监听数据更新 - 直接透传，不关心具体结构
        unlisteners.push(
            await listen<PopupDataPayload>('popup-data', (event) => {
                if (event.payload.windowLabel && event.payload.windowLabel !== currentLabel) return;
                popupType.value = event.payload.type;
                popupData.value = event.payload.data;
            })
        );

        // 焦点返回主窗口
        unlisteners.push(
            await getCurrentWindow().listen('tauri://focus', () => {
                emit('popup-focus-main', {});
            })
        );

        // 键盘事件转发
        unlisteners.push(
            await listen<{ key: string }>('popup-keydown', (event) => {
                componentRef.value?.handleKeyDown?.(
                    new KeyboardEvent('keydown', { key: event.payload.key })
                );
            })
        );

        // ESC 关闭
        window.addEventListener('keydown', handleKeyDown);
    });

    onUnmounted(() => {
        unlisteners.forEach((fn) => fn());
        window.removeEventListener('keydown', handleKeyDown);
    });
</script>

<template>
    <div class="popup-container h-screen w-screen bg-transparent">
        <component
            :is="popupComponent"
            v-if="popupComponent"
            ref="componentRef"
            :data="popupData"
            :is-in-popup="true"
            @close="close"
        />
    </div>
</template>

<style scoped>
    .popup-container {
        display: flex;
        align-items: flex-start;
        justify-content: center;
    }
</style>
