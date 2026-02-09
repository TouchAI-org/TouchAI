// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { native } from '@services/NativeService';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { initializeBuiltInPopups, popupRegistry } from './registry';
import type {
    PopupData,
    PopupDataPayload,
    PopupEventHandlers,
    PopupPosition,
    PopupType,
    WindowInfo,
} from './types';

/**
 * Popup 管理器
 * 负责 popup 窗口的初始化、显示、隐藏和事件管理
 */
class PopupManager {
    private isInitialized = false;
    private isInitializing = false;
    private isOpen = false;
    private currentType: PopupType | null = null;

    /**
     * 初始化 Popup 系统
     * 1. 初始化内置 popup
     * 2. 将配置同步到 Rust 后端
     * 3. 触发 Rust 预加载窗口
     */
    async initialize(): Promise<void> {
        if (this.isInitialized || this.isInitializing) {
            return;
        }

        this.isInitializing = true;

        try {
            initializeBuiltInPopups();

            const configs = popupRegistry.getSerializableConfig();
            if (configs.length === 0) {
                throw new Error('No popup configs available');
            }

            await native.window.registerPopupConfigs(configs);

            // 触发预加载（不等待完成）
            native.window.preloadPopupWindows().catch((error) => {
                console.error('[PopupManager] Preload failed:', error);
            });

            this.isInitialized = true;
        } catch (error) {
            console.error('[PopupManager] Failed to initialize:', error);
        } finally {
            this.isInitializing = false;
        }
    }

    /**
     * 显示弹窗
     */
    async show(type: PopupType, triggerElement: HTMLElement, data: PopupData): Promise<void> {
        try {
            const position = await this.calculatePosition(type, triggerElement);

            await native.window.showPopupWindow({
                x: position.x,
                y: position.y,
                width: position.width,
                height: position.height,
                popupType: type,
            });

            const windowLabel = `popup-${type}`;
            await emit('popup-data', {
                type,
                data,
                windowLabel,
            } as PopupDataPayload);

            this.isOpen = true;
            this.currentType = type;
        } catch (error) {
            console.error('[PopupManager] Failed to show popup:', error);
            throw error;
        }
    }

    /**
     * 隐藏弹窗
     */
    async hide(): Promise<void> {
        try {
            await native.window.hidePopupWindow();
            await emit('popup-closed', {});

            this.isOpen = false;
            this.currentType = null;
        } catch (error) {
            console.error('[PopupManager] Failed to hide popup:', error);
        }
    }

    /**
     * 切换弹窗（打开/关闭）
     */
    async toggle(type: PopupType, triggerElement: HTMLElement, data: PopupData): Promise<void> {
        if (this.isOpen && this.currentType === type) {
            await this.hide();
            return;
        }

        if (this.isOpen) {
            await this.hide();
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        await this.show(type, triggerElement, data);
    }

    /**
     * 更新弹窗数据
     */
    async updateData(data: PopupData): Promise<void> {
        if (!this.isOpen || !this.currentType) return;

        try {
            await emit('popup-data', {
                type: this.currentType,
                data,
                windowLabel: `popup-${this.currentType}`,
            } as PopupDataPayload);
        } catch (error) {
            console.error('[PopupManager] Failed to update popup data:', error);
        }
    }

    /**
     * 监听弹窗事件
     */
    async listen(handlers: PopupEventHandlers): Promise<() => void> {
        const unlisteners: Array<() => void> = [];

        if (handlers.onModelSelect) {
            const unlisten = await listen<{ modelDbId: number }>('popup-model-select', (event) => {
                handlers.onModelSelect?.(event.payload.modelDbId);
            });
            unlisteners.push(unlisten);
        }

        if (handlers.onAttachmentAction) {
            const unlisten = await listen<{ action: 'remove' | 'preview'; attachmentId: string }>(
                'popup-attachment-action',
                (event) => {
                    handlers.onAttachmentAction?.(event.payload.action, event.payload.attachmentId);
                }
            );
            unlisteners.push(unlisten);
        }

        if (handlers.onClose) {
            const unlisten = await listen('popup-closed', () => {
                handlers.onClose?.();
                this.isOpen = false;
                this.currentType = null;
            });
            unlisteners.push(unlisten);
        }

        return () => {
            unlisteners.forEach((unlisten) => unlisten());
        };
    }

    /**
     * 获取当前状态
     */
    get state() {
        return {
            isOpen: this.isOpen,
            currentType: this.currentType,
            isInitialized: this.isInitialized,
        };
    }

    /**
     * 计算弹窗位置
     */
    private async calculatePosition(
        type: PopupType,
        triggerElement: HTMLElement
    ): Promise<PopupPosition> {
        const config = popupRegistry.get(type);
        if (!config) {
            throw new Error(`[PopupManager] Popup type '${type}' not registered`);
        }

        // 收集必要信息
        const mainWindow = getCurrentWindow();

        const scaleFactor = await mainWindow.scaleFactor();
        const mainPosition = (await mainWindow.outerPosition()).toLogical(scaleFactor);
        const mainSize = (await mainWindow.outerSize()).toLogical(scaleFactor);
        const innerSize = (await mainWindow.innerSize()).toLogical(scaleFactor);

        const windowInfo: WindowInfo = {
            position: { x: mainPosition.x, y: mainPosition.y },
            size: { width: mainSize.width, height: mainSize.height },
            innerSize: { width: innerSize.width, height: innerSize.height },
            scaleFactor,
        };

        const dimensions = { width: config.width, height: config.height };

        // 调用自定义方法计算位置
        const position = config.calculatePosition(triggerElement, windowInfo, dimensions);

        return {
            x: position.x,
            y: position.y,
            width: config.width,
            height: 0,
        };
    }
}

// 导出单例
export const popupManager = new PopupManager();
