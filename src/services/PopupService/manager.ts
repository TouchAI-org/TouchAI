// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { AppEvent, eventService } from '@services/EventService';
import { native } from '@services/NativeService';
import { getCurrentWindow, Window as TauriWindow } from '@tauri-apps/api/window';

import { initializeBuiltInPopups, popupRegistry } from './registry';
import type {
    PopupClosedPayload,
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
    private currentPopupId: string | null = null;
    private currentWindowLabel: string | null = null;
    private readyListenerInitialized = false;
    private readyPopupWindows = new Set<string>();
    private pendingPopupDataByWindow = new Map<string, PopupDataPayload>();
    private recoveringPopupWindows = new Map<string, number>();
    private popupSessionVersionByWindow = new Map<string, number>();

    private async ensureReadyListener(): Promise<void> {
        if (this.readyListenerInitialized) {
            return;
        }

        await eventService.on(AppEvent.POPUP_READY, ({ windowLabel }) => {
            this.readyPopupWindows.add(windowLabel);

            const pendingPayload = this.pendingPopupDataByWindow.get(windowLabel);
            if (!pendingPayload) {
                return;
            }

            this.pendingPopupDataByWindow.delete(windowLabel);

            void eventService.emit(AppEvent.POPUP_DATA, pendingPayload).catch((error) => {
                console.error(
                    `[PopupManager] Failed to replay popup data for '${windowLabel}':`,
                    error
                );
            });
        });

        await eventService.on(AppEvent.POPUP_CLOSED, (payload) => {
            this.finalizePopupClosed(payload);
        });
        this.readyListenerInitialized = true;
    }

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
            await this.ensureReadyListener();
            await this.syncPopupConfigs();

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
    async show(type: PopupType, triggerElement: HTMLElement, data: PopupData): Promise<string> {
        const windowLabel = this.getWindowLabel(type);
        const popupSessionVersion = (this.popupSessionVersionByWindow.get(windowLabel) ?? 0) + 1;
        const popupId = this.buildPopupId(windowLabel, popupSessionVersion);

        try {
            if (!this.isInitialized) {
                await this.initialize();
            } else {
                // show 前先同步 popup 配置，确保原生注册表与前端声明的 popup 类型保持一致。
                await this.syncPopupConfigs();
            }

            const position = await this.calculatePosition(type, triggerElement);
            this.popupSessionVersionByWindow.set(windowLabel, popupSessionVersion);
            this.currentType = type;
            this.currentPopupId = popupId;
            this.currentWindowLabel = windowLabel;
            this.isOpen = true;
            await this.showPopupWindow(type, position);

            // isShow: true 标记此事件为弹窗首次展示，PopupView 仅在此时触发
            // invalidate → pendingShow → resize → show 流程。
            // 常规 updateData 发送的 popup-data 不带此标记，避免与 popup-closed 竞态。
            await this.dispatchPopupData({
                popupId,
                type,
                data,
                windowLabel,
                isShow: true,
            });
            void this.recoverPopupWindowIfNeeded(windowLabel, type, position, popupSessionVersion);
            return popupId;
        } catch (error) {
            this.resetCurrentPopupState(popupId);
            console.error('[PopupManager] Failed to show popup:', error);
            throw error;
        }
    }

    /**
     * 隐藏弹窗
     */
    async hide(): Promise<void> {
        try {
            const closePayload = this.getCurrentPopupClosedPayload();
            await native.window.hidePopupWindow();
            if (!closePayload) {
                return;
            }

            await eventService.emit(AppEvent.POPUP_CLOSED, closePayload);
            this.finalizePopupClosed(closePayload);
        } catch (error) {
            console.error('[PopupManager] Failed to hide popup:', error);
        }
    }

    /**
     * 切换弹窗（打开/关闭）
     */
    async toggle(
        type: PopupType,
        triggerElement: HTMLElement,
        data: PopupData
    ): Promise<string | null> {
        if (this.isOpen && this.currentType === type) {
            await this.hide();
            return null;
        }

        if (this.isOpen) {
            await this.hide();
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        return this.show(type, triggerElement, data);
    }

    /**
     * 更新弹窗数据
     */
    async updateData(data: PopupData): Promise<void> {
        if (!this.isOpen || !this.currentType || !this.currentPopupId || !this.currentWindowLabel) {
            return;
        }

        try {
            await this.dispatchPopupData({
                popupId: this.currentPopupId,
                type: this.currentType,
                data,
                windowLabel: this.currentWindowLabel,
            });
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
            const unlisten = await eventService.on(AppEvent.POPUP_MODEL_SELECT, ({ modelDbId }) => {
                handlers.onModelSelect?.(modelDbId);
            });
            unlisteners.push(unlisten);
        }

        if (handlers.onSessionOpen) {
            const unlisten = await eventService.on(AppEvent.POPUP_SESSION_OPEN, ({ sessionId }) => {
                handlers.onSessionOpen?.(sessionId);
            });
            unlisteners.push(unlisten);
        }

        if (handlers.onSessionSearchQueryChange) {
            const unlisten = await eventService.on(
                AppEvent.POPUP_SESSION_SEARCH_QUERY_CHANGE,
                ({ query }) => {
                    handlers.onSessionSearchQueryChange?.(query);
                }
            );
            unlisteners.push(unlisten);
        }

        if (handlers.onClose) {
            const unlisten = await eventService.on(AppEvent.POPUP_CLOSED, (payload) => {
                handlers.onClose?.(payload);
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

    private async showPopupWindow(type: PopupType, position: PopupPosition): Promise<void> {
        await native.window.showPopupWindow({
            x: position.x,
            y: position.y,
            width: position.width,
            height: position.height,
            popupType: type,
        });
    }

    private async dispatchPopupData(payload: PopupDataPayload): Promise<void> {
        const windowLabel = payload.windowLabel ?? '';
        const shouldQueuePending =
            windowLabel.length > 0 && !this.readyPopupWindows.has(windowLabel);
        const existingPayload = shouldQueuePending
            ? this.pendingPopupDataByWindow.get(windowLabel)
            : undefined;
        const nextPayload =
            existingPayload &&
            existingPayload.popupId === payload.popupId &&
            existingPayload.isShow &&
            payload.isShow !== true
                ? {
                      ...payload,
                      isShow: true,
                  }
                : payload;

        if (windowLabel) {
            if (shouldQueuePending) {
                this.pendingPopupDataByWindow.set(windowLabel, nextPayload);
            } else {
                this.pendingPopupDataByWindow.delete(windowLabel);
            }
        }

        await eventService.emit(AppEvent.POPUP_DATA, nextPayload);
    }

    private async recoverPopupWindowIfNeeded(
        windowLabel: string,
        type: PopupType,
        position: PopupPosition,
        popupSessionVersion: number
    ): Promise<void> {
        if (this.readyPopupWindows.has(windowLabel)) {
            return;
        }

        if (this.recoveringPopupWindows.get(windowLabel) === popupSessionVersion) {
            return;
        }

        this.recoveringPopupWindows.set(windowLabel, popupSessionVersion);

        try {
            if (!this.isCurrentPopupSession(windowLabel, popupSessionVersion)) {
                return;
            }

            const isReady = await this.waitForPopupWindowReady(windowLabel, 450);
            if (!this.isCurrentPopupSession(windowLabel, popupSessionVersion)) {
                return;
            }

            if (isReady) {
                return;
            }

            const popupWindow = await TauriWindow.getByLabel(windowLabel);
            const isVisible =
                (await popupWindow?.isVisible().catch((visibilityError) => {
                    console.error(
                        `[PopupManager] Failed to inspect popup window '${windowLabel}' visibility:`,
                        visibilityError
                    );
                    return false;
                })) ?? false;

            // 仅在窗口仍处于隐藏状态时执行后台重建；已可见窗口继续复用以避免闪烁。
            if (isVisible) {
                return;
            }

            console.warn(
                `[PopupManager] Popup window '${windowLabel}' was not ready in time and is still hidden, recreating in background`
            );

            if (!this.isCurrentPopupSession(windowLabel, popupSessionVersion)) {
                return;
            }

            await popupWindow?.close().catch((closeError) => {
                console.error(
                    `[PopupManager] Failed to close stale popup window '${windowLabel}':`,
                    closeError
                );
            });

            if (!this.isCurrentPopupSession(windowLabel, popupSessionVersion)) {
                return;
            }

            this.readyPopupWindows.delete(windowLabel);
            await new Promise((resolve) => setTimeout(resolve, 120));
            if (!this.isCurrentPopupSession(windowLabel, popupSessionVersion)) {
                return;
            }
            await this.showPopupWindow(type, position);
        } finally {
            if (this.recoveringPopupWindows.get(windowLabel) === popupSessionVersion) {
                this.recoveringPopupWindows.delete(windowLabel);
            }
        }
    }

    /**
     * popup 恢复属于延迟异步任务；窗口在等待期间可能已经切换到新的会话版本。
     * 这里用按窗口递增的代次号隔离不同会话，避免过期任务拿错误位置重建弹窗。
     */
    private isCurrentPopupSession(windowLabel: string, popupSessionVersion: number): boolean {
        return this.popupSessionVersionByWindow.get(windowLabel) === popupSessionVersion;
    }

    /**
     * popup 关闭既可能来自主窗口的 hide，也可能来自 popup 自己触发的 close；
     * 两条路径都必须统一作废当前代次，避免过期恢复任务在关闭后再次拉起窗口。
     */
    private finalizePopupClosed(payload: PopupClosedPayload): void {
        if (
            this.currentType !== payload.type ||
            this.currentPopupId !== payload.popupId ||
            this.currentWindowLabel !== payload.windowLabel
        ) {
            return;
        }

        this.pendingPopupDataByWindow.delete(payload.windowLabel);
        this.popupSessionVersionByWindow.set(
            payload.windowLabel,
            (this.popupSessionVersionByWindow.get(payload.windowLabel) ?? 0) + 1
        );
        this.currentPopupId = null;
        this.currentWindowLabel = null;
        this.isOpen = false;
        this.currentType = null;
    }

    private getCurrentPopupClosedPayload(): PopupClosedPayload | null {
        if (!this.currentType || !this.currentPopupId || !this.currentWindowLabel) {
            return null;
        }

        return {
            popupId: this.currentPopupId,
            type: this.currentType,
            windowLabel: this.currentWindowLabel,
        };
    }

    private resetCurrentPopupState(popupId: string): void {
        if (this.currentPopupId !== popupId) {
            return;
        }

        this.currentPopupId = null;
        this.currentWindowLabel = null;
        this.currentType = null;
        this.isOpen = false;
    }

    private getWindowLabel(type: PopupType): string {
        return `popup-${type}`;
    }

    private buildPopupId(windowLabel: string, popupSessionVersion: number): string {
        return `${windowLabel}:${popupSessionVersion}`;
    }

    private async waitForPopupWindowReady(
        windowLabel: string,
        timeoutMs: number
    ): Promise<boolean> {
        if (this.readyPopupWindows.has(windowLabel)) {
            return true;
        }

        const startedAt = Date.now();
        while (!this.readyPopupWindows.has(windowLabel) && Date.now() - startedAt < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        return this.readyPopupWindows.has(windowLabel);
    }

    private async syncPopupConfigs(): Promise<void> {
        initializeBuiltInPopups();

        const configs = popupRegistry.getSerializableConfig();
        if (configs.length === 0) {
            throw new Error('No popup configs available');
        }

        await native.window.registerPopupConfigs(configs);
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

        // 获取屏幕信息
        const { currentMonitor } = await import('@tauri-apps/api/window');
        const monitor = await currentMonitor();
        const screenSize = monitor
            ? {
                  width: monitor.size.width / scaleFactor,
                  height: monitor.size.height / scaleFactor,
              }
            : undefined;
        const screenPosition = monitor
            ? {
                  x: monitor.position.x / scaleFactor,
                  y: monitor.position.y / scaleFactor,
              }
            : undefined;

        const windowInfo: WindowInfo = {
            position: { x: mainPosition.x, y: mainPosition.y },
            size: { width: mainSize.width, height: mainSize.height },
            innerSize: { width: innerSize.width, height: innerSize.height },
            scaleFactor,
            screenSize,
            screenPosition,
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
