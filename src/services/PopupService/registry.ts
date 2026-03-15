// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import ModelDropdownPopup from '@/views/PopupView/components/ModelDropdownPopup/index.vue';

import type { PopupConfig, PopupType, SerializablePopupConfig, WindowInfo } from './types';

const GAP = 5;
const SHADOW_WIDTH = 7;

/**
 * 计算弹窗的 Y 坐标：优先显示在窗口下方，超出屏幕则翻转到搜索框上方
 */
function calculatePopupY(
    triggerElement: HTMLElement,
    mainWindow: WindowInfo,
    popupHeight: number
): number {
    // 优先显示在窗口下方（相对于窗口底部）
    let y = mainWindow.position.y + mainWindow.size.height + GAP;

    // 检查是否超出屏幕底部
    if (mainWindow.screenSize && mainWindow.screenPosition) {
        const screenBottom = mainWindow.screenPosition.y + mainWindow.screenSize.height;
        const popupBottom = y + popupHeight;

        // 如果超出屏幕底部，改为显示在搜索框上方
        if (popupBottom > screenBottom) {
            const searchBarContainer = triggerElement.closest('.search-bar-container');
            const refElement = searchBarContainer || triggerElement;
            const refRect = refElement.getBoundingClientRect();
            const refTopY = mainWindow.position.y + refRect.top;
            y = refTopY - popupHeight - GAP;
        }
    }

    return y;
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
        if (this.popups.has(config.id)) {
            console.warn(`[PopupRegistry] Popup '${config.id}' already registered, overwriting`);
        }
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
        calculatePosition: (triggerElement, mainWindow, dimensions) => {
            const x = mainWindow.position.x - SHADOW_WIDTH;
            const y = calculatePopupY(triggerElement, mainWindow, dimensions.height);
            return { x, y };
        },
    });
}
