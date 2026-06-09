<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { useWindowResize } from '@composables/useWindowResize';
    import { AppEvent, eventService } from '@services/EventService';
    import { native } from '@services/NativeService';
    import type { PopupDataPayload, PopupKeydownPayload, PopupType } from '@services/PopupService';
    import { initializeBuiltInPopups, popupRegistry } from '@services/PopupService';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';

    import { useSettingsStore } from '@/stores/settings';

    import { getPopupTypeFromLocation } from './location';

    defineOptions({
        name: 'PopupWindowView',
    });

    const popupType = ref<PopupType | null>(null);
    const popupId = ref<string | null>(null);
    const popupSessionVersion = ref<number | null>(null);
    const popupData = shallowRef<unknown>(null);
    const componentRef = ref<{
        handleKeyDown?: (e: KeyboardEvent) => void;
        handlePopupShown?: () => void;
    } | null>(null);
    const popupContent = ref<HTMLElement | null>(null);
    const unlisteners: (() => void)[] = [];
    const closedPopupIds = new Set<string>();
    let emptyPopupHideTimer: number | null = null;

    const popupComponent = computed(() =>
        popupType.value ? popupRegistry.get(popupType.value)?.component : null
    );
    const popupProps = computed(() => {
        return {
            data: popupData.value,
            isInPopup: true,
            popupIdentity:
                popupId.value && popupSessionVersion.value !== null
                    ? {
                          popupId: popupId.value,
                          windowLabel: getCurrentWindow().label,
                          popupSessionVersion: popupSessionVersion.value,
                      }
                    : null,
        };
    });

    /**
     * 请求 Rust 关闭当前 popup 窗口。
     */
    async function close() {
        const currentPopupId = popupId.value;
        const currentPopupSessionVersion = popupSessionVersion.value;
        const currentWindowLabel = getCurrentWindow().label;

        popupId.value = null;
        popupSessionVersion.value = null;
        popupData.value = null;
        resetMeasuredHeight();

        if (currentPopupId && currentPopupSessionVersion !== null) {
            await native.window
                .hidePopupWindow({
                    popupId: currentPopupId,
                    windowLabel: currentWindowLabel,
                    popupSessionVersion: currentPopupSessionVersion,
                })
                .catch((error: unknown) => {
                    console.error(
                        '[PopupView] Failed to hide popup window via native manager:',
                        error
                    );
                });
        }
    }

    function clearEmptyPopupHideTimer() {
        if (!emptyPopupHideTimer) {
            return;
        }

        window.clearTimeout(emptyPopupHideTimer);
        emptyPopupHideTimer = null;
    }

    function scheduleEmptyPopupHide() {
        clearEmptyPopupHideTimer();
        emptyPopupHideTimer = window.setTimeout(() => {
            emptyPopupHideTimer = null;
            if (popupId.value || popupData.value !== null) {
                return;
            }

            void getCurrentWindow()
                .hide()
                .catch((error) => {
                    console.error('[PopupView] Failed to hide empty popup window:', error);
                });
        }, 150);
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
    const type = getPopupTypeFromLocation(window.location) as PopupType | null;
    popupType.value = type;

    const config = type ? popupRegistry.get(type) : null;
    const { requestResize, resetMeasuredHeight } = useWindowResize({
        target: popupContent,
        maxHeight: config?.height,
        minHeight: config?.minHeight,
    });

    onMounted(async () => {
        useSettingsStore()
            .initialize()
            .catch((error) => {
                console.error('[PopupView] Failed to initialize settings:', error);
            });

        const currentLabel = getCurrentWindow().label;

        /**
         * 判断 payload 是否仍然对应当前 popup 会话。
         */
        function isCurrentPayloadSession(payload: PopupDataPayload) {
            return (
                popupId.value === payload.popupId &&
                popupSessionVersion.value === payload.popupSessionVersion &&
                popupType.value === payload.type
            );
        }

        // 监听数据更新 - 直接透传，不关心具体结构
        unlisteners.push(
            await eventService.on(AppEvent.POPUP_DATA, async (payload: PopupDataPayload) => {
                if (payload.windowLabel !== currentLabel) return;
                clearEmptyPopupHideTimer();

                if (closedPopupIds.has(payload.popupId)) {
                    return;
                }

                if (!payload.isShow && popupId.value !== payload.popupId) {
                    return;
                }

                popupId.value = payload.popupId;
                popupSessionVersion.value = payload.popupSessionVersion;
                popupType.value = payload.type;
                popupData.value = payload.data;
                await nextTick();
                if (!isCurrentPayloadSession(payload)) {
                    return;
                }
                await requestResize();
                if (payload.isShow) {
                    await getCurrentWindow()
                        .show()
                        .catch((error: unknown) => {
                            console.error('[PopupView] Failed to show popup window:', error);
                        });
                    await nextTick();
                    if (!isCurrentPayloadSession(payload)) {
                        return;
                    }

                    await getCurrentWindow().setFocus();
                    await nextTick();
                    if (!isCurrentPayloadSession(payload)) {
                        return;
                    }
                    componentRef.value?.handlePopupShown?.();
                }
            })
        );

        await eventService.emit(AppEvent.POPUP_READY, {
            windowLabel: currentLabel,
        });
        scheduleEmptyPopupHide();

        // 监听关闭事件：终止当前 pendingShow 流程，避免关闭后再次执行 show。
        unlisteners.push(
            await eventService.on(AppEvent.POPUP_CLOSED, (payload) => {
                if (payload.windowLabel !== currentLabel) {
                    return;
                }

                closedPopupIds.add(payload.popupId);

                if (popupId.value && payload.popupId !== popupId.value) {
                    return;
                }

                if (payload.popupId === popupId.value) {
                    popupId.value = null;
                    popupSessionVersion.value = null;
                    popupData.value = null;
                }
                resetMeasuredHeight();
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
        clearEmptyPopupHideTimer();
        unlisteners.forEach((fn) => fn());
        window.removeEventListener('keydown', handleKeyDown);
    });
</script>

<template>
    <div class="popup-container w-screen bg-transparent">
        <div v-if="popupComponent" ref="popupContent" class="popup-content w-screen">
            <component :is="popupComponent" ref="componentRef" v-bind="popupProps" @close="close" />
        </div>
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
