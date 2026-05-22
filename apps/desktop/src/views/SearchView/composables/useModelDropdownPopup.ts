import {
    type ModelDropdownData,
    type PopupClosedPayload,
    popupManager,
} from '@services/PopupService';
import { onMounted, onUnmounted, ref } from 'vue';

import type { SearchPopupSessionIdentity } from './searchInteraction';

interface UseModelDropdownPopupOptions {
    getAnchorElement: () => HTMLElement | null;
    getPopupData: () => ModelDropdownData;
    isModelDropdownActive: () => boolean;
    onModelSelect: (modelDbId: number) => Promise<void> | void;
    onModelSearchQueryChange: (query: string) => Promise<void> | void;
    onClose: () => void;
    onPopupSessionStart?: (identity: SearchPopupSessionIdentity) => void;
    onPopupSessionEnd?: () => void;
}

/**
 * 从 popupId 中解析 popup session version。
 */
function parsePopupSessionVersion(popupId: string) {
    const segments = popupId.split(':');
    const value = Number(segments[segments.length - 1] ?? '');
    return Number.isFinite(value) ? value : 0;
}
/**
 * 判断指定模型下拉 popup 会话是否仍然是 popupManager 当前会话。
 */
function isLiveModelDropdownPopupSession(identity: SearchPopupSessionIdentity) {
    const state = popupManager.state;
    return (
        state.isOpen === true &&
        state.currentType === 'model-dropdown-popup' &&
        state.currentPopupId === identity.popupId &&
        state.currentWindowLabel === identity.windowLabel &&
        state.currentPopupSessionVersion === identity.popupSessionVersion
    );
}

/**
 * 模型下拉弹窗驱动层。
 * 负责封装 popupManager 交互、弹窗数据组装和全局 popup 事件监听，
 * 让模型选择领域逻辑只依赖显式 popup 接口，而不感知底层实现细节。
 *
 * @param options 模型下拉框触发元素、弹窗上下文数据和事件回调。
 * @returns 模型下拉弹窗状态与打开/关闭/更新方法。
 */
export function useModelDropdownPopup(options: UseModelDropdownPopupOptions) {
    const {
        getAnchorElement,
        getPopupData,
        isModelDropdownActive,
        onModelSelect,
        onModelSearchQueryChange,
        onClose,
        onPopupSessionStart,
        onPopupSessionEnd,
    } = options;

    let cleanupFn: (() => void) | null = null;
    let activePopupId: string | null = null;
    let hasActivePopupSession = false;
    let disposed = false;
    const isOpen = ref(false);

    /**
     * 打开模型下拉弹窗。
     * 弹窗驱动层只依赖页面层已准备好的锚点与数据，不承担页面布局时序控制。
     *
     * @returns Promise<void>
     */
    async function open() {
        const anchorElement = getAnchorElement();
        if (!anchorElement) {
            return;
        }

        const popupId = await popupManager.show(
            'model-dropdown-popup',
            anchorElement,
            getPopupData()
        );
        const identity = popupId
            ? {
                  popupId,
                  windowLabel: 'popup-model-dropdown-popup',
                  popupSessionVersion: parsePopupSessionVersion(popupId),
              }
            : null;
        const isLivePopupSession = identity ? isLiveModelDropdownPopupSession(identity) : false;

        if (!identity || !isLivePopupSession) {
            activePopupId = null;
            hasActivePopupSession = false;
            isOpen.value = false;
            onPopupSessionEnd?.();
            return;
        }

        activePopupId = identity.popupId;
        hasActivePopupSession = true;
        isOpen.value = true;
        onPopupSessionStart?.(identity);
    }

    /**
     * 关闭模型下拉弹窗。
     *
     * @returns Promise<void>
     */
    async function close() {
        if (!hasActivePopupSession && !isOpen.value) {
            return;
        }

        const closingIdentity =
            activePopupId !== null
                ? {
                      popupId: activePopupId,
                      windowLabel: 'popup-model-dropdown-popup',
                      popupSessionVersion: parsePopupSessionVersion(activePopupId),
                  }
                : null;
        activePopupId = null;
        hasActivePopupSession = false;
        isOpen.value = false;
        onPopupSessionEnd?.();

        if (closingIdentity) {
            await popupManager.hide(closingIdentity);
        }
    }

    /**
     * 将最新的模型筛选上下文同步到 popup 窗口。
     *
     * @returns Promise<void>
     */
    async function updateData() {
        if (!hasActivePopupSession || !isOpen.value) {
            return;
        }

        await popupManager.updateData(getPopupData());
    }

    onMounted(() => {
        disposed = false;

        void popupManager
            .listen({
                onModelSelect: (modelDbId) => {
                    void Promise.resolve(onModelSelect(modelDbId)).catch((error) => {
                        console.error(
                            '[SearchView] Failed to handle model dropdown selection:',
                            error
                        );
                    });
                },
                onModelSearchQueryChange: (query) => {
                    void Promise.resolve(onModelSearchQueryChange(query)).catch((error) => {
                        console.error(
                            '[SearchView] Failed to update model dropdown search query from popup:',
                            error
                        );
                    });
                },
                onClose: (payload: PopupClosedPayload) => {
                    if (!activePopupId || payload.popupId !== activePopupId) {
                        return;
                    }

                    activePopupId = null;
                    hasActivePopupSession = false;
                    isOpen.value = false;
                    onPopupSessionEnd?.();

                    // popup-closed 是全局事件，这里只在模型下拉实际持有同一 popupId 时
                    // 才通知领域层关闭，避免切换其他 popup 时误重置模型搜索状态。
                    if (!isModelDropdownActive()) {
                        return;
                    }
                    onClose();
                },
            })
            .then((nextCleanupFn) => {
                if (disposed) {
                    nextCleanupFn();
                    return;
                }

                cleanupFn = nextCleanupFn;
            })
            .catch((error) => {
                console.error(
                    '[SearchView] Failed to register model dropdown popup listeners:',
                    error
                );
            });
    });

    onUnmounted(() => {
        disposed = true;
        cleanupFn?.();
        cleanupFn = null;
        activePopupId = null;
        hasActivePopupSession = false;
        isOpen.value = false;
        onPopupSessionEnd?.();
    });

    /**
     * 判断当前 driver 持有的 popup 会话是否仍然存活。
     */
    function isLiveSession() {
        if (!activePopupId) {
            return false;
        }

        return isLiveModelDropdownPopupSession({
            popupId: activePopupId,
            windowLabel: 'popup-model-dropdown-popup',
            popupSessionVersion: parsePopupSessionVersion(activePopupId),
        });
    }

    return {
        isOpen,
        open,
        close,
        updateData,
        isLiveSession,
    };
}
