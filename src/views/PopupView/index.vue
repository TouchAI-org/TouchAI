<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { useWindowResize } from '@composables/useWindowResize';
    import type { PopupDataPayload, PopupType } from '@services/PopupService';
    import { initializeBuiltInPopups, popupRegistry } from '@services/PopupService';
    import { emit, listen } from '@tauri-apps/api/event';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';

    defineOptions({
        name: 'PopupWindowView',
    });

    const popupType = ref<PopupType | null>(null);
    const popupData = shallowRef<unknown>(null);
    const componentRef = ref<{ handleKeyDown?: (e: KeyboardEvent) => void } | null>(null);
    const popupContainer = ref<HTMLElement | null>(null);
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

    // 初始化内置弹窗注册表（PopupView 有独立的 JS 上下文）
    initializeBuiltInPopups();

    // 从 URL 获取类型，在 setup 阶段同步读取以便 useWindowResize 能拿到配置
    const type = new URLSearchParams(window.location.search).get('type') as PopupType;
    popupType.value = type;

    const config = type ? popupRegistry.get(type) : null;
    const { invalidate, cancelPendingShow } = useWindowResize({
        target: popupContainer,
        maxHeight: config?.height,
        minHeight: config?.minHeight,
    });

    onMounted(async () => {
        const currentLabel = getCurrentWindow().label;

        // 监听数据更新 - 直接透传，不关心具体结构
        unlisteners.push(
            await listen<PopupDataPayload>('popup-data', (event) => {
                if (event.payload.windowLabel !== currentLabel) return;
                popupType.value = event.payload.type;
                popupData.value = event.payload.data;
                // 仅在弹窗首次展示（isShow）时 invalidate，触发 resize → show 流程。
                // 纯数据更新（如搜索过滤）由 ResizeObserver 自行处理高度变化，
                // 避免 updateData 的 popup-data 事件与 popup-closed 竞态
                // 导致已关闭的弹窗被 pendingShow 重新显示。
                if (event.payload.isShow) {
                    invalidate();
                }
            })
        );

        // 监听关闭事件：取消待执行的 show，防止 invalidate 触发的异步 resize
        // 在窗口隐藏后才完成，导致 pendingShow 重新将窗口显示出来。
        unlisteners.push(
            await listen('popup-closed', () => {
                cancelPendingShow();
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
    <div ref="popupContainer" class="popup-container w-screen bg-transparent">
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
