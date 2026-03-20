// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import ModelDropdownPopup from '@/views/PopupView/components/ModelDropdownPopup/index.vue';
import SessionHistoryPopover from '@/views/PopupView/components/SessionHistoryPopover/index.vue';

import type { PopupConfig, PopupType, SerializablePopupConfig, WindowInfo } from './types';

const GAP = 5;
const SHADOW_WIDTH = 7;

/**
 * 在优先位置与回退位置之间选择一个可见的 Y 坐标，并在必要时钳制到屏幕内。
 *
 * @param mainWindow 主窗口与屏幕几何信息。
 * @param popupHeight 弹窗最大高度。
 * @param preferredY 首选 Y 坐标。
 * @param fallbackY 回退 Y 坐标。
 * @returns 屏幕范围内的弹窗 Y 坐标。
 */
function calculatePopupY(
    mainWindow: WindowInfo,
    popupHeight: number,
    preferredY: number,
    fallbackY: number
): number {
    if (!mainWindow.screenSize || !mainWindow.screenPosition) {
        return preferredY;
    }

    const screenTop = mainWindow.screenPosition.y;
    const screenHeight = mainWindow.screenSize.height;
    const screenBottom = screenTop + screenHeight;
    const minY = screenTop;
    const maxY = screenTop + Math.max(0, screenHeight - popupHeight);

    const isFullyVisible = (candidateY: number) => {
        return candidateY >= minY && candidateY + popupHeight <= screenBottom;
    };

    if (isFullyVisible(preferredY)) {
        return preferredY;
    }

    if (isFullyVisible(fallbackY)) {
        return fallbackY;
    }

    return clamp(preferredY, minY, maxY);
}

/**
 * 计算模型下拉弹窗的 Y 坐标：优先贴主窗口下边缘，超出屏幕时翻转到搜索条上方。
 *
 * @param triggerElement 触发元素。
 * @param mainWindow 主窗口与屏幕几何信息。
 * @param popupHeight 弹窗最大高度。
 * @returns 屏幕范围内的弹窗 Y 坐标。
 */
function calculateWindowEdgePopupY(
    triggerElement: HTMLElement,
    mainWindow: WindowInfo,
    popupHeight: number
): number {
    const preferredY = mainWindow.position.y + mainWindow.size.height + GAP;
    const searchBarContainer = triggerElement.closest('.search-bar-container');
    const refElement = searchBarContainer || triggerElement;
    const refRect = refElement.getBoundingClientRect();
    const fallbackY = mainWindow.position.y + refRect.top - popupHeight - GAP;

    return calculatePopupY(mainWindow, popupHeight, preferredY, fallbackY);
}

/**
 * 计算工具栏类弹窗的 Y 坐标：优先显示在触发按钮下方，超出屏幕时再翻到上方。
 *
 * @param triggerElement 触发元素。
 * @param mainWindow 主窗口与屏幕几何信息。
 * @param popupHeight 弹窗最大高度。
 * @returns 屏幕范围内的弹窗 Y 坐标。
 */
function calculateTriggerAnchoredPopupY(
    triggerElement: HTMLElement,
    mainWindow: WindowInfo,
    popupHeight: number
): number {
    const triggerRect = triggerElement.getBoundingClientRect();
    const preferredY = mainWindow.position.y + triggerRect.bottom + GAP;
    const fallbackY = mainWindow.position.y + triggerRect.top - popupHeight - GAP;

    return calculatePopupY(mainWindow, popupHeight, preferredY, fallbackY);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function calculateRightAlignedPopupX(
    triggerElement: HTMLElement,
    mainWindow: WindowInfo,
    popupWidth: number
): number {
    const triggerRect = triggerElement.getBoundingClientRect();
    let x = mainWindow.position.x + triggerRect.right - popupWidth - SHADOW_WIDTH;

    if (mainWindow.screenSize && mainWindow.screenPosition) {
        const minX = mainWindow.screenPosition.x;
        const maxX =
            mainWindow.screenPosition.x + Math.max(0, mainWindow.screenSize.width - popupWidth);
        x = clamp(x, minX, maxX);
    }

    return x;
}

/**
 * Popup 注册表类
 */
class PopupRegistry {
    private popups = new Map<PopupType, PopupConfig>();

    /**
     * 注册一个 popup
     */
    register<TData = unknown>(config: PopupConfig<TData>): void {
        this.popups.set(config.id, config);
    }

    /**
     * 获取指定 popup 配置
     */
    get(id: PopupType): PopupConfig | undefined {
        return this.popups.get(id);
    }

    /**
     * 获取所有 popup 配置
     */
    getAll(): PopupConfig[] {
        return Array.from(this.popups.values());
    }

    /**
     * 获取可序列化的配置（用于传递给 Rust）
     */
    getSerializableConfig(): SerializablePopupConfig[] {
        return this.getAll().map((config) => ({
            id: config.id,
            width: config.width,
            height: config.height,
        }));
    }

    /**
     * 检查 popup 是否已注册
     */
    has(id: PopupType): boolean {
        return this.popups.has(id);
    }
}

/**
 * 全局 Popup 注册表实例
 */
export const popupRegistry = new PopupRegistry();

/**
 * 初始化内置 popup 注册
 */
export function initializeBuiltInPopups(): void {
    // 注册模型下拉框（左侧）
    popupRegistry.register({
        id: 'model-dropdown-popup',
        width: 320,
        height: 384,
        component: ModelDropdownPopup,
        returnFocusToMainWindowOnFocus: true,
        calculatePosition: (triggerElement, mainWindow, dimensions) => {
            const x = mainWindow.position.x - SHADOW_WIDTH;
            const y = calculateWindowEdgePopupY(triggerElement, mainWindow, dimensions.height);
            return { x, y };
        },
    });

    popupRegistry.register({
        id: 'session-history-popup',
        width: 320,
        height: 384,
        component: SessionHistoryPopover,
        returnFocusToMainWindowOnFocus: false,
        calculatePosition: (triggerElement, mainWindow, dimensions) => {
            const x = calculateRightAlignedPopupX(triggerElement, mainWindow, dimensions.width);
            const y = calculateTriggerAnchoredPopupY(triggerElement, mainWindow, dimensions.height);
            return { x, y };
        },
    });
}
