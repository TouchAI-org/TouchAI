<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { useWindowResize } from '@composables/useWindowResize';
    import { AppEvent, eventService } from '@services/EventService';
    import { native } from '@services/NativeService';
    import type {
        PopupClosedPayload,
        PopupDataPayload,
        PopupKeydownPayload,
        PopupType,
    } from '@services/PopupService';
    import { initializeBuiltInPopups, popupRegistry } from '@services/PopupService';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';

    defineOptions({
        name: 'PopupWindowView',
    });

    const popupType = ref<PopupType | null>(null);
    const popupId = ref<string | null>(null);
    const popupData = shallowRef<unknown>(null);
    const componentRef = ref<{
        handleKeyDown?: (e: KeyboardEvent) => void;
        handlePopupShown?: () => void;
    } | null>(null);
    const popupContainer = ref<HTMLElement | null>(null);
    const unlisteners: (() => void)[] = [];

    const popupComponent = computed(() =>
        popupType.value ? popupRegistry.get(popupType.value)?.component : null
    );
    const popupProps = computed(() => {
        return {
            data: popupData.value,
            isInPopup: true,
        };
    });

    async function close() {
        const currentPopupId = popupId.value;
        const currentType = popupType.value;
        if (currentPopupId && currentType) {
            await eventService.emit(AppEvent.POPUP_CLOSED, {
                popupId: currentPopupId,
                type: currentType,
                windowLabel: getCurrentWindow().label,
            } satisfies PopupClosedPayload);
        }

        await getCurrentWindow().hide();
    }

    function handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            void close();
            return;
        }

        componentRef.value?.handleKeyDown?.(e);
    }

    // 初始化内置弹窗注册表（PopupView 有独立的 JS 上下文）
    initializeBuiltInPopups();

    // 从 URL 获取类型，在 setup 阶段同步读取以便 useWindowResize 能拿到配置
    const type = new URLSearchParams(window.location.search).get('type') as PopupType;
    popupType.value = type;

    const config = type ? popupRegistry.get(type) : null;
    const shouldReturnFocusToMainWindow = config?.returnFocusToMainWindowOnFocus !== false;
    const { invalidate, cancelScheduledWindowShow } = useWindowResize({
        target: popupContainer,
        maxHeight: config?.height,
        minHeight: config?.minHeight,
    });

    onMounted(async () => {
        const currentLabel = getCurrentWindow().label;

        // 监听数据更新 - 直接透传，不关心具体结构
        unlisteners.push(
            await eventService.on(AppEvent.POPUP_DATA, async (payload: PopupDataPayload) => {
                if (payload.windowLabel !== currentLabel) return;
                popupId.value = payload.popupId;
                popupType.value = payload.type;
                popupData.value = payload.data;
                // 仅在弹窗首次展示（isShow）时 invalidate，触发 resize → show 流程。
                // 纯数据更新（如搜索过滤）由 ResizeObserver 自行处理高度变化，
                // 避免 updateData 的 popup-data 事件与 popup-closed 竞态
                // 导致已关闭的弹窗又被旧的显示流程拉起来。
                if (payload.isShow) {
                    await invalidate();
                    if (!shouldReturnFocusToMainWindow) {
                        await getCurrentWindow().setFocus();
                    }
                    await nextTick();
                    componentRef.value?.handlePopupShown?.();
                }
            })
        );

        await eventService.emit(AppEvent.POPUP_READY, {
            windowLabel: currentLabel,
        });

        // 监听关闭事件：终止这次“resize 后再显示”的计划，避免关闭后旧流程又把窗口拉起。
        unlisteners.push(
            await eventService.on(AppEvent.POPUP_CLOSED, (payload: PopupClosedPayload) => {
                if (payload.windowLabel !== currentLabel) {
                    return;
                }

                if (popupId.value && payload.popupId !== popupId.value) {
                    return;
                }

                if (payload.popupId === popupId.value) {
                    popupId.value = null;
                }
                cancelScheduledWindowShow();
            })
        );

        // 焦点返回主窗口
        unlisteners.push(
            await getCurrentWindow().listen('tauri://focus', () => {
                if (!shouldReturnFocusToMainWindow) {
                    return;
                }
                void eventService.emit(AppEvent.POPUP_FOCUS_MAIN, {});
            })
        );

        unlisteners.push(
            await getCurrentWindow().listen('tauri://blur', async () => {
                try {
                    const appFocused = await native.window.isAppFocused();
                    if (!appFocused) {
                        await close();
                    }
                } catch (error) {
                    console.error('[PopupView] Failed to close popup on blur:', error);
                }
            })
        );

        // 键盘事件转发
        unlisteners.push(
            await eventService.on(AppEvent.POPUP_KEYDOWN, (payload: PopupKeydownPayload) => {
                // popup 窗口会被预加载并常驻监听全局事件；
                // 只有命中当前窗口类型的按键转发才应该被消费，避免隐藏窗口串台。
                if (payload.targetType !== popupType.value) {
                    return;
                }

                componentRef.value?.handleKeyDown?.(
                    new KeyboardEvent('keydown', { key: payload.key })
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
            v-bind="popupProps"
            @close="close"
        />
    </div>
</template>

<style scoped>
    .popup-container {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        overflow: hidden;
        border-radius: 0.5rem;
    }
</style>
