// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import AttachmentOverflowPopup from '@/views/popups/AttachmentOverflowPopup.vue';
import ModelDropdownPopup from '@/views/popups/ModelDropdownPopup.vue';

import type { PopupConfig, PopupType, SerializablePopupConfig } from './types';

const GAP = 5;
const SHADOW_WIDTH = 7;

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
        calculatePosition: (triggerElement, mainWindow) => {
            const searchBarContainer = triggerElement.closest('.search-bar-container');
            const searchBarHeight = searchBarContainer?.getBoundingClientRect().height || 60;

            return {
                x: mainWindow.position.x - SHADOW_WIDTH,
                y: mainWindow.position.y + searchBarHeight + GAP,
            };
        },
    });

    // 注册附件溢出（右侧）
    popupRegistry.register({
        id: 'attachment-overflow-popup',
        width: 256,
        height: 320,
        component: AttachmentOverflowPopup,
        calculatePosition: (triggerElement, mainWindow, dimensions) => {
            const searchBarContainer = triggerElement.closest('.search-bar-container');
            const searchBarHeight = searchBarContainer?.getBoundingClientRect().height || 60;

            return {
                x: mainWindow.position.x + mainWindow.size.width - dimensions.width - SHADOW_WIDTH,
                y: mainWindow.position.y + searchBarHeight + GAP,
            };
        },
    });
}
