import {
    type PopupClosedPayload,
    popupManager,
    type SessionHistoryData,
} from '@services/PopupService';
import { onMounted, onUnmounted, ref } from 'vue';

interface UseSessionHistoryPopupOptions {
    getAnchorElement: () => HTMLElement | null;
    getPopupData: () => SessionHistoryData;
    isSessionHistoryActive: () => boolean;
    onSessionOpen: (sessionId: number) => Promise<void> | void;
    onSessionSearchQueryChange: (query: string) => Promise<void> | void;
    onClose: () => Promise<void> | void;
}

/**
 * 历史会话 popup 驱动层。
 * 负责封装 popupManager 交互和跨窗口事件监听，避免页面层直接感知 popup 事件协议。
 *
 * @param options 历史会话 popup 的锚点、数据和领域回调。
 * @returns popup 打开状态以及打开、关闭、同步数据的方法。
 */
export function useSessionHistoryPopup(options: UseSessionHistoryPopupOptions) {
    const {
        getAnchorElement,
        getPopupData,
        isSessionHistoryActive,
        onSessionOpen,
        onSessionSearchQueryChange,
        onClose,
    } = options;

    let cleanupFn: (() => void) | null = null;
    let activePopupId: string | null = null;
    let hasActivePopupSession = false;
    let disposed = false;
    const isOpen = ref(false);

    /**
     * 打开历史会话 popup。
     *
     * @returns Promise<void>
     */
    async function open() {
        const anchorElement = getAnchorElement();
        if (!anchorElement) {
            return;
        }

        try {
            const popupId = await popupManager.toggle(
                'session-history-popup',
                anchorElement,
                getPopupData()
            );
            activePopupId = popupId;
            hasActivePopupSession = Boolean(popupId);
            isOpen.value = Boolean(popupId);
        } catch (error) {
            activePopupId = null;
            hasActivePopupSession = false;
            isOpen.value = false;
            throw error;
        }
    }

    /**
     * 关闭历史会话 popup。
     *
     * @returns Promise<void>
     */
    async function close() {
        if (!hasActivePopupSession && !isOpen.value) {
            return;
        }

        await popupManager.hide();
        activePopupId = null;
        hasActivePopupSession = false;
        isOpen.value = false;
    }

    /**
     * 把最新历史会话上下文同步到 popup 窗口。
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

        // 监听注册是异步的；如果页面在注册完成前就被卸载，
        // 这里要把迟到的 cleanup 立即执行掉，避免全局事件残留到下一次挂载。
        void popupManager
            .listen({
                onSessionOpen: (sessionId) => {
                    void Promise.resolve(onSessionOpen(sessionId)).catch((error) => {
                        console.error(
                            '[SearchView] Failed to open history session from popup:',
                            error
                        );
                    });
                },
                onSessionSearchQueryChange: (query) => {
                    void Promise.resolve(onSessionSearchQueryChange(query)).catch((error) => {
                        console.error(
                            '[SearchView] Failed to update history search query from popup:',
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

                    if (!isSessionHistoryActive()) {
                        return;
                    }

                    void Promise.resolve(onClose()).catch((error) => {
                        console.error('[SearchView] Failed to handle history popup close:', error);
                    });
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
                console.error('[SearchView] Failed to register history popup listeners:', error);
            });
    });

    onUnmounted(() => {
        disposed = true;
        const shouldHidePopup = hasActivePopupSession || isOpen.value;
        activePopupId = null;
        hasActivePopupSession = false;
        isOpen.value = false;
        cleanupFn?.();
        cleanupFn = null;

        if (!shouldHidePopup) {
            return;
        }

        // 组件销毁时主动结束 popup 会话，避免残留窗口继续向已卸载页面回调。
        void popupManager.hide().catch((error) => {
            console.error('[SearchView] Failed to hide history popup on unmount:', error);
        });
    });

    return {
        isOpen,
        open,
        close,
        updateData,
    };
}
