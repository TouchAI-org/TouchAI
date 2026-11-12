import { log } from '@services/ObservabilityService';
// Copyright (c) 2026. 千诚. Licensed under GPL v3
/**
 * 搜索窗口尺寸决策层（纯函数，无副作用）。
 *
 * 包含三个职责：
 * 1. 高度策略决策 — 根据页面状态输出窗口高度策略
 * 2. 窗口状态转换 — 最大化/还原的状态管理
 * 3. 节流调度 — 防止高频 resize 事件淹没 IPC
 */
import { getCurrentWindow } from '@tauri-apps/api/window';

import { SEARCH_CONVERSATION_AUTO_MAX_HEIGHT } from '@/config/searchWindow';

/** Physical top inset used by the compact search surface on monitor hosts. */
export const SEARCH_WINDOW_TOP_INSET = 96;

// ============================================================
// 类型定义
// ============================================================

export interface SearchWindowHeightPolicyInput {
    sessionCount: number;
    quickSearchOpen: boolean;
    skillAutocompleteOpen?: boolean;
}

export interface SearchWindowConversationLayoutInput {
    hasConversationPanel: boolean;
    isMaximized: boolean;
    shouldRespectManualHeightOverride: boolean;
    isIntrinsicHeightMeasurementPending?: boolean;
}

export interface SearchWindowDefaultSizeApplyInput {
    ready: boolean;
    maximized: boolean;
    hasManagedPanel: boolean;
}

export interface SearchWindowHeightPolicy {
    hasManagedPanel: boolean;
    autoResizeEnabled: boolean;
    respectManualOverride: boolean;
    allowHeightOverride: boolean;
}

export interface SearchWindowMinimumSizeInput {
    defaultWidth: number;
    defaultHeight: number;
    hasManagedPanel: boolean;
    autoHeightFloor: number;
}

export interface SearchWindowResizeConstraints {
    minWidth: number;
    minHeight: number;
    maxHeight: number | null;
}

export type SearchWindowDefaultSizeApplyAction =
    | 'skip'
    | 'reset_idle_bounds'
    | 'reset_and_remeasure_managed_panel';

export interface AutoSessionPanelHeightInput {
    searchBarHeight: number;
    conversationMaxHeight?: number;
}

export function resolveAutoSessionPanelHeight(input: AutoSessionPanelHeightInput) {
    const searchBarHeight = Math.max(
        60,
        Math.round(Number.isFinite(input.searchBarHeight) ? input.searchBarHeight : 60)
    );
    const conversationMaxHeight = Math.max(
        0,
        Math.round(
            Number.isFinite(input.conversationMaxHeight)
                ? (input.conversationMaxHeight as number)
                : SEARCH_CONVERSATION_AUTO_MAX_HEIGHT
        )
    );
    return searchBarHeight + conversationMaxHeight;
}

export interface SearchWindowMeasuredHeightInput {
    panelHeight: number;
    overlayBottom: number | null;
    overlayRequiredViewportHeight: number | null;
    monitorHost: boolean;
}

/** Include fixed inline overlays only when the native host is content-bounded. */
export function resolveSearchWindowMeasuredHeight(input: SearchWindowMeasuredHeightInput) {
    if (input.monitorHost) {
        return input.panelHeight;
    }

    const overlayHeights = [input.overlayBottom, input.overlayRequiredViewportHeight].filter(
        (height): height is number => height !== null && Number.isFinite(height)
    );

    return Math.max(input.panelHeight, ...overlayHeights);
}

// ============================================================
// 高度策略决策
// ============================================================

/**
 * 根据会话状态计算高度策略。
 *
 * - 空态（无会话、QuickSearch 关闭）：允许内容驱动的自动 resize（让 SearchBar 多行
 *   时窗口跟随扩展），但禁止手动覆盖。
 * - 对话态：启用自动 resize，允许手动覆盖，遵循 ManualOverride。
 * - QuickSearch / Skills 自动补全打开但无会话：启用自动 resize，但不允许手动覆盖。
 */
export function resolveSearchWindowHeightPolicy(
    input: SearchWindowHeightPolicyInput
): SearchWindowHeightPolicy {
    const hasConversationPanel = input.sessionCount > 0;
    const hasManagedPanel =
        hasConversationPanel || input.quickSearchOpen || (input.skillAutocompleteOpen ?? false);

    return {
        hasManagedPanel,
        autoResizeEnabled: true,
        respectManualOverride: hasConversationPanel,
        allowHeightOverride: hasConversationPanel,
    };
}

/**
 * 决定默认尺寸变更后的窗口操作：
 * - 未就绪或最大化 → skip（延迟到恢复后再处理）
 * - 有面板 → reset 并重新测量
 * - 空态 → 仅 reset
 */
export function resolveSearchWindowDefaultSizeApplyAction(
    input: SearchWindowDefaultSizeApplyInput
): SearchWindowDefaultSizeApplyAction {
    if (!input.ready || input.maximized) {
        return 'skip';
    }

    return input.hasManagedPanel ? 'reset_and_remeasure_managed_panel' : 'reset_idle_bounds';
}

/**
 * 计算搜索窗口的最小尺寸约束。
 *
 * - 有面板时 minHeight = max(默认高度, 自动高度下限)，maxHeight = null（不限制）
 * - 空态时 minHeight = maxHeight = 默认高度（锁定）
 */
export function resolveSearchWindowMinimumSize(
    input: SearchWindowMinimumSizeInput
): SearchWindowResizeConstraints {
    const height = input.hasManagedPanel
        ? Math.max(input.defaultHeight, input.autoHeightFloor)
        : input.defaultHeight;

    return {
        minWidth: input.defaultWidth,
        minHeight: height,
        maxHeight: input.hasManagedPanel ? null : input.defaultHeight,
    };
}

/**
 * 判断对话面板是否应撑满可用高度（最大化或手动覆盖模式下生效）。
 *
 * 最大化时忽略 intrinsic 测量锁：工作区已经由 native host 撑满，
 * 对话区必须立刻吃掉剩余高度，否则搜索栏会停在内容高度中间。
 */
export function shouldFillConversationAvailableHeight(input: SearchWindowConversationLayoutInput) {
    if (!input.hasConversationPanel) {
        return false;
    }

    if (input.isMaximized) {
        return true;
    }

    return !input.isIntrinsicHeightMeasurementPending && input.shouldRespectManualHeightOverride;
}

// ============================================================
// 窗口状态转换
// ============================================================

export interface MaximizableWindow {
    isMaximized: () => Promise<boolean>;
    maximize: () => Promise<void>;
    unmaximize: () => Promise<void>;
}

/**
 * 监听 onResized 事件，等待窗口状态转换稳定。
 *
 * Windows 上 maximize/unmaximize 有动画，期间 onResized 每帧触发。
 * 通过 50ms debounce 等动画结束后读取最终状态。
 * timeoutMs 兜底防止事件永远不触发。
 */
function waitForWindowStabilized(timeoutMs = 200): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const unlisten = getCurrentWindow().onResized(() => {
            if (settled) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    void unlisten.then((fn) => fn());
                    void getCurrentWindow().isMaximized().then(resolve);
                }
            }, 50);
        });

        setTimeout(() => {
            if (!settled) {
                settled = true;
                if (debounceTimer) clearTimeout(debounceTimer);
                void unlisten.then((fn) => fn());
                resolve(false);
            }
        }, timeoutMs);
    });
}

/**
 * 确保窗口从最大化状态还原。
 *
 * 通过 onResized 事件驱动确认，无轮询。
 */
export async function ensureWindowRestoredFromMaximized(window: MaximizableWindow) {
    if (!(await window.isMaximized())) {
        return true;
    }

    await window.unmaximize();
    await waitForWindowStabilized();
    return !(await window.isMaximized());
}

/**
 * 确保窗口处于最大化状态。
 *
 * 通过 onResized 事件驱动确认，无轮询。
 */
export async function ensureWindowMaximized(window: MaximizableWindow) {
    if (await window.isMaximized()) {
        return true;
    }

    await window.maximize();
    return waitForWindowStabilized();
}

/**
 * 计算有效最大化状态：过渡期间也视为最大化，防止中间态触发自动高度。
 */
export function resolveEffectiveWindowMaximized(
    isMaximized: boolean,
    isMaximizeTransitioning: boolean
) {
    return isMaximized || isMaximizeTransitioning;
}

/**
 * 从最大化还原后是否需要重新测量面板高度。
 * 最大化期间面板撑满了全屏，还原后需回到自动高度模式。
 */
export function shouldRemeasureAfterMaximizedRestore(input: {
    wasMaximized: boolean;
    isMaximized: boolean;
    hasManagedPanel: boolean;
}) {
    return input.hasManagedPanel && input.wasMaximized && !input.isMaximized;
}

// ============================================================
// 节流同步调度
// ============================================================

export interface WindowViewportSyncScheduler {
    schedule: () => void;
    cancel: () => void;
}

/**
 * 创建节流同步调度器。
 *
 * - 首次调用或距上次同步已超过 throttleMs → 立即执行
 * - 节流窗口内的后续调用 → 合并为一次延迟执行（尾调用保证）
 *
 * @param sync - 实际同步逻辑（异步）
 * @param throttleMs - 节流间隔，默认 120ms（短于动画时长 180ms，确保动画结束后及时同步）
 */
export function createWindowViewportSyncScheduler(
    sync: () => Promise<void>,
    throttleMs = 120
): WindowViewportSyncScheduler {
    let lastSyncStartedAt = 0;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;

    function clearTrailingTimer() {
        if (!trailingTimer) {
            return;
        }

        clearTimeout(trailingTimer);
        trailingTimer = null;
    }

    function runSync() {
        lastSyncStartedAt = Date.now();
        void sync().catch((error) => {
            log.error('[SearchView] Failed to sync viewport state:', error);
        });
    }

    function schedule() {
        const now = Date.now();
        const elapsed = now - lastSyncStartedAt;

        // 首次调用或已过节流窗口 → 立即执行
        if (lastSyncStartedAt === 0 || elapsed >= throttleMs) {
            clearTrailingTimer();
            runSync();
            return;
        }

        // 节流窗口内 → 重置延迟定时器（尾调用保证最后一次一定执行）
        clearTrailingTimer();
        trailingTimer = setTimeout(() => {
            trailingTimer = null;
            runSync();
        }, throttleMs - elapsed);
    }

    return {
        schedule,
        cancel: clearTrailingTimer,
    };
}
