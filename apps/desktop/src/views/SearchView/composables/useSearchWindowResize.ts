// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { computed, nextTick, onUnmounted, type Ref, ref, watch } from 'vue';

import { type SearchWindowDefaultSize, SearchWindowHeightMode } from '@/config/searchWindow';
import {
    createWindowViewportSyncScheduler,
    ensureWindowMaximized,
    ensureWindowRestoredFromMaximized,
    resolveEffectiveWindowMaximized,
    resolveSearchWindowDefaultSizeApplyAction,
    resolveSearchWindowHeightPolicy,
    resolveSearchWindowMinimumSize,
    shouldEnforceIdleDefaultBounds,
    shouldFillConversationAvailableHeight,
    shouldRemeasureAfterMaximizedRestore,
    shouldRepairIdleSearchWindowHeight,
} from '@/views/SearchView/windowSizing';

interface UseSearchWindowResizeOptions {
    target: Ref<HTMLElement | null>;
    sessionCount: Ref<number>;
    quickSearchOpen: Ref<boolean>;
    defaultSize: Ref<SearchWindowDefaultSize>;
    ready: Ref<boolean>;
}

/**
 * 搜索窗口大小专用状态机。
 *
 * 负责统一管理页面内容高度、原生窗口状态、搜索窗口策略
 */
export function useSearchWindowResize(options: UseSearchWindowResizeOptions) {
    const currentWindow = getCurrentWindow();
    const currentHeight = ref(0);
    const desiredMaximized = ref(false);
    const isMaximizeTransitioning = ref(false);
    const searchWindowHeightMode = ref<SearchWindowHeightMode>(SearchWindowHeightMode.Auto);
    const searchWindowResizeConstraintsReady = ref(false);

    const searchWindowHeightPolicy = computed(() =>
        resolveSearchWindowHeightPolicy({
            sessionCount: options.sessionCount.value,
            quickSearchOpen: options.quickSearchOpen.value,
        })
    );
    const effectiveWindowMaximized = computed(() =>
        resolveEffectiveWindowMaximized(desiredMaximized.value, isMaximizeTransitioning.value)
    );
    const autoHeightEnabled = computed(() => {
        // ManualOverride 只在有会话时生效；
        // 一旦用户手动改过对话窗口高度，就停止内容驱动的自动伸缩。
        const manualOverrideActive =
            searchWindowHeightPolicy.value.respectManualOverride &&
            searchWindowHeightMode.value === SearchWindowHeightMode.ManualOverride;

        return (
            options.ready.value &&
            searchWindowHeightPolicy.value.autoResizeEnabled &&
            !effectiveWindowMaximized.value &&
            !manualOverrideActive
        );
    });
    const fillConversationAvailableHeight = computed(() =>
        shouldFillConversationAvailableHeight({
            hasConversationPanel: options.sessionCount.value > 0,
            isMaximized: effectiveWindowMaximized.value,
            shouldRespectManualHeightOverride:
                searchWindowHeightPolicy.value.respectManualOverride &&
                searchWindowHeightMode.value === SearchWindowHeightMode.ManualOverride,
        })
    );
    const contentReady = computed(
        () => options.ready.value && searchWindowResizeConstraintsReady.value
    );

    let resizeObserver: ResizeObserver | null = null;
    let unlistenWindowResize: (() => void) | null = null;
    let lastResizeConstraintsKey: string | null = null;
    let lastAllowHeightOverride: boolean | null = null;
    let lastSyncedDefaultSizeKey: string | null = null;
    let pendingDefaultSizeApplyAfterRestore = false;

    const viewportSyncScheduler = createWindowViewportSyncScheduler(syncViewportState, 80);

    function reportError(action: string, error: unknown) {
        console.error(`[SearchView] Failed to ${action}:`, error);
    }

    function getDefaultSizeKey() {
        const { width, height } = options.defaultSize.value;
        return `${width}:${height}`;
    }

    function measureElementHeight(el: HTMLElement) {
        return Math.max(
            el.getBoundingClientRect().height,
            el.clientHeight,
            el.scrollHeight,
            el.offsetHeight
        );
    }

    async function isWindowVisible() {
        return currentWindow.isVisible().catch(() => true);
    }

    async function syncMaximizedState() {
        desiredMaximized.value = await currentWindow.isMaximized().catch(() => false);
    }

    async function syncSearchWindowHeightMode() {
        const state = await native.window.getSearchWindowState();
        searchWindowHeightMode.value = state.heightMode;

        if (state.heightMode === SearchWindowHeightMode.Auto) {
            currentHeight.value = state.currentHeight;
        }
    }

    async function syncWindowState() {
        await syncMaximizedState();
        await syncSearchWindowHeightMode();
    }

    async function syncSearchWindowAllowHeightOverride() {
        if (!options.ready.value) {
            return;
        }

        const allowHeightOverride = searchWindowHeightPolicy.value.allowHeightOverride;
        if (lastAllowHeightOverride === allowHeightOverride) {
            return;
        }

        await native.window.setSearchWindowAllowHeightOverride(allowHeightOverride);
        lastAllowHeightOverride = allowHeightOverride;
    }

    async function syncSearchWindowMinSizeConstraints(nextAutoHeightFloor?: number) {
        if (!options.ready.value) {
            return;
        }

        const defaultSize = options.defaultSize.value;
        // 有面板时，最小高度跟随“默认高度”和“当前自动高度 floor”中的较大者。
        // 这样既不会让用户把窗口缩得比默认值更小，也不会在收缩前被旧的 minHeight 卡住。
        const autoHeightFloor = Math.max(
            defaultSize.height,
            nextAutoHeightFloor ?? currentHeight.value ?? 0
        );
        const constraints = resolveSearchWindowMinimumSize({
            defaultWidth: defaultSize.width,
            defaultHeight: defaultSize.height,
            hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
            autoHeightFloor,
        });
        const constraintsKey = JSON.stringify(constraints);

        if (lastResizeConstraintsKey === constraintsKey) {
            searchWindowResizeConstraintsReady.value = true;
            return;
        }

        await native.window.setSearchWindowMinSize(constraints);
        lastResizeConstraintsKey = constraintsKey;
        searchWindowResizeConstraintsReady.value = true;
    }

    async function resetSearchWindowBounds() {
        currentHeight.value = options.defaultSize.value.height;
        searchWindowHeightMode.value = SearchWindowHeightMode.Auto;
        await native.window.resetSearchWindowBounds();
        await syncSearchWindowMinSizeConstraints();
    }

    async function resize(pageHeight: number) {
        const newHeight = Math.ceil(pageHeight);

        if (!autoHeightEnabled.value || !(await isWindowVisible())) {
            return;
        }

        if (newHeight < currentHeight.value) {
            // 收缩前先下调原生最小高度约束，否则 Windows 会直接拒绝这次 shrink。
            await syncSearchWindowMinSizeConstraints(newHeight);
        }

        await native.window.resizeWindowHeight({
            targetHeight: newHeight,
            center: true,
            animate: false,
            respectManualOverride: searchWindowHeightPolicy.value.respectManualOverride,
        });
        currentHeight.value = newHeight;
        await syncSearchWindowMinSizeConstraints(newHeight);
    }

    async function resizeToTargetElement(el: HTMLElement) {
        await resize(measureElementHeight(el));
    }

    async function remeasureTargetHeight() {
        const target = options.target.value;
        if (!target) {
            return;
        }

        // 切会话时不能只依赖 ResizeObserver；
        // 当前窗口高度本身可能没先变化，因此这里提供显式重测入口。
        await nextTick();
        await resizeToTargetElement(target);
    }

    async function syncSearchWindowDefaults() {
        if (!options.ready.value) {
            return;
        }

        const defaultSizeKey = getDefaultSizeKey();
        if (lastSyncedDefaultSizeKey !== defaultSizeKey) {
            await native.window.setSearchWindowDefaults(options.defaultSize.value);
            lastSyncedDefaultSizeKey = defaultSizeKey;
        }

        const applyAction = resolveSearchWindowDefaultSizeApplyAction({
            ready: options.ready.value,
            maximized: effectiveWindowMaximized.value,
            hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
        });

        if (applyAction === 'skip') {
            pendingDefaultSizeApplyAfterRestore = effectiveWindowMaximized.value;
            await syncSearchWindowMinSizeConstraints();
            return;
        }

        pendingDefaultSizeApplyAfterRestore = false;
        await resetSearchWindowBounds();

        if (applyAction === 'reset_and_remeasure_managed_panel') {
            await remeasureTargetHeight();
        }
    }

    async function syncViewportState(previousMaximized = desiredMaximized.value) {
        if (!options.ready.value) {
            return;
        }

        // 统一吸收窗口系统事件后的原生状态，再决定是否要补默认尺寸或重新测量。
        await syncWindowState();
        await syncSearchWindowAllowHeightOverride();
        await syncSearchWindowMinSizeConstraints();

        if (pendingDefaultSizeApplyAfterRestore && !effectiveWindowMaximized.value) {
            await syncSearchWindowDefaults();
            return;
        }

        if (
            shouldRemeasureAfterMaximizedRestore({
                wasMaximized: previousMaximized,
                isMaximized: desiredMaximized.value,
                hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
            })
        ) {
            await remeasureTargetHeight();
        }
    }

    async function toggleMaximize() {
        if (isMaximizeTransitioning.value) {
            return;
        }

        const wasMaximized = desiredMaximized.value;
        const nextMaximized = !wasMaximized;

        desiredMaximized.value = nextMaximized;
        isMaximizeTransitioning.value = true;

        try {
            if (nextMaximized) {
                await ensureWindowMaximized(currentWindow);
            } else {
                await ensureWindowRestoredFromMaximized(currentWindow);
            }
        } finally {
            await syncViewportState(wasMaximized).catch((error) => {
                reportError('sync viewport state after maximize toggle', error);
            });
            isMaximizeTransitioning.value = false;
        }
    }

    function observeTarget(el: HTMLElement) {
        resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const target = entry.target as HTMLElement;
                const height = Math.max(
                    entry.borderBoxSize?.[0]?.blockSize ?? target.clientHeight,
                    target.scrollHeight,
                    target.getBoundingClientRect().height
                );
                resize(height).catch((error) => {
                    reportError('apply observed height resize', error);
                });
            }
        });
        resizeObserver.observe(el);

        const runInitialResize = () => {
            if (autoHeightEnabled.value) {
                void remeasureTargetHeight().catch((error) => {
                    reportError('run initial managed-panel resize', error);
                });
            }
        };

        if (document.readyState === 'complete') {
            runInitialResize();
        } else {
            window.addEventListener('load', runInitialResize, { once: true });
        }
    }

    function cleanup() {
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
    }

    watch(
        options.target,
        (el) => {
            cleanup();
            if (el) {
                observeTarget(el);
            }
        },
        { immediate: true }
    );

    watch(
        () => options.ready.value,
        (ready) => {
            if (!ready) {
                searchWindowResizeConstraintsReady.value = false;
                return;
            }

            void syncWindowState().catch((error) => {
                reportError('sync window state', error);
            });
            void syncSearchWindowAllowHeightOverride().catch((error) => {
                reportError('sync height override policy', error);
            });
            void syncSearchWindowDefaults().catch((error) => {
                reportError('sync search window defaults', error);
            });
        },
        { immediate: true, flush: 'post' }
    );

    watch(
        () => ({
            ready: options.ready.value,
            defaultWidth: options.defaultSize.value.width,
            defaultHeight: options.defaultSize.value.height,
        }),
        ({ ready, defaultWidth, defaultHeight }, previous) => {
            if (!ready) {
                return;
            }

            if (
                previous &&
                previous.defaultWidth === defaultWidth &&
                previous.defaultHeight === defaultHeight
            ) {
                return;
            }

            void syncSearchWindowDefaults().catch((error) => {
                reportError('apply search window defaults', error);
            });
        },
        { flush: 'post' }
    );

    watch(
        () => ({
            ready: options.ready.value,
            hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
            allowHeightOverride: searchWindowHeightPolicy.value.allowHeightOverride,
        }),
        ({ ready }) => {
            if (!ready) {
                return;
            }

            void syncSearchWindowAllowHeightOverride().catch((error) => {
                reportError('sync search window override policy', error);
            });
            void syncSearchWindowMinSizeConstraints().catch((error) => {
                reportError('sync search window min size', error);
            });
        },
        { immediate: true, flush: 'post' }
    );

    watch(
        autoHeightEnabled,
        (enabled, previous) => {
            if (!enabled || enabled === previous) {
                return;
            }

            void remeasureTargetHeight().catch((error) => {
                reportError('remeasure managed panel after auto-height re-enabled', error);
            });
        },
        { flush: 'post' }
    );

    watch(
        () => ({
            ready: options.ready.value,
            idle: !searchWindowHeightPolicy.value.hasManagedPanel,
            heightMode: searchWindowHeightMode.value,
            maximized: effectiveWindowMaximized.value,
            hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
        }),
        (current, previous) => {
            if (!current.ready) {
                return;
            }

            // 空态不允许继承对话态留下的 ManualOverride 或放大后的高度，
            // 因此一旦切回 idle，需要强制回到默认窗口尺寸。
            const shouldRepairIdleHeight = shouldRepairIdleSearchWindowHeight(
                {
                    ready: current.ready,
                    idle: current.idle,
                    heightMode: current.heightMode,
                    maximized: current.maximized,
                },
                previous
                    ? {
                          ready: previous.ready,
                          idle: previous.idle,
                          heightMode: previous.heightMode,
                          maximized: previous.maximized,
                      }
                    : undefined
            );

            const shouldRepairIdleBounds = shouldEnforceIdleDefaultBounds(
                {
                    ready: current.ready,
                    hasManagedPanel: current.hasManagedPanel,
                    maximized: current.maximized,
                },
                previous
                    ? {
                          ready: previous.ready,
                          hasManagedPanel: previous.hasManagedPanel,
                          maximized: previous.maximized,
                      }
                    : undefined
            );

            if (!shouldRepairIdleHeight && !shouldRepairIdleBounds) {
                return;
            }

            void resetSearchWindowBounds().catch((error) => {
                reportError('repair idle search window bounds', error);
            });
        },
        { flush: 'post' }
    );

    currentWindow
        .onResized(() => {
            if (!options.ready.value) {
                return;
            }

            viewportSyncScheduler.schedule();
        })
        .then((unlisten) => {
            unlistenWindowResize = unlisten;
        })
        .catch((error) => {
            reportError('listen for window resize', error);
        });

    onUnmounted(() => {
        cleanup();
        viewportSyncScheduler.cancel();
        unlistenWindowResize?.();
    });

    return {
        contentReady,
        isMaximized: desiredMaximized,
        effectiveWindowMaximized,
        fillConversationAvailableHeight,
        toggleMaximize,
        syncWindowState,
        remeasureTargetHeight,
    };
}
