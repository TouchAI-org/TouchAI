// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { AppEvent, eventService } from '@services/EventService';
import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { initializeBuiltInPopups, popupRegistry } from './registry';
import type {
    PopupClosedPayload,
    PopupData,
    PopupDataPayload,
    PopupEventHandlers,
    PopupSessionIdentity,
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
    private currentPopupSessionVersion: number | null = null;
    private readyListenerInitialized = false;
    private readyPopupWindows = new Set<string>();
    private pendingPopupDataByWindow = new Map<string, PopupDataPayload>();
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

            // 让初始化真正等待 popup 预热完成，避免首次 Ctrl+H 还在走冷启动链路。
            await native.window.preloadPopupWindows();

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
            this.currentPopupSessionVersion = popupSessionVersion;
            this.isOpen = true;
            await this.showPopupWindow(type, position, {
                popupId,
                popupSessionVersion,
                windowLabel,
            });

            // isShow: true 标记此事件为弹窗首次展示。
            // 原生窗口显示由 PopupManager.show() 单点负责，避免跨窗口 resize/show 竞态。
            await this.dispatchPopupData({
                popupId,
                popupSessionVersion,
                type,
                data,
                windowLabel,
                isShow: true,
            });
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
    async hide(identity?: PopupSessionIdentity): Promise<void> {
        try {
            const closePayload = identity
                ? this.getPopupClosedPayloadForIdentity(identity)
                : this.getCurrentPopupClosedPayload();
            if (!closePayload) {
                return;
            }
            await native.window.hidePopupWindow({
                popupId: closePayload.popupId,
                windowLabel: closePayload.windowLabel,
                popupSessionVersion: closePayload.popupSessionVersion,
            });
        } catch (error) {
            console.error('[PopupManager] Failed to hide popup:', error);
        }
    }

    /**
     * 更新弹窗数据
     */
    async updateData(data: PopupData): Promise<void> {
        if (
            !this.isOpen ||
            !this.currentType ||
            !this.currentPopupId ||
            !this.currentWindowLabel ||
            this.currentPopupSessionVersion === null
        ) {
            return;
        }

        try {
            await this.dispatchPopupData({
                popupId: this.currentPopupId,
                popupSessionVersion: this.currentPopupSessionVersion,
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
            const unlisten = await eventService.on(AppEvent.POPUP_MODEL_SELECT, (payload) => {
                if (!this.isCurrentPopupEvent(payload)) {
                    return;
                }

                handlers.onModelSelect?.(payload.modelDbId);
            });
            unlisteners.push(unlisten);
        }

        if (handlers.onModelSearchQueryChange) {
            const unlisten = await eventService.on(
                AppEvent.POPUP_MODEL_SEARCH_QUERY_CHANGE,
                (payload) => {
                    if (!this.isCurrentPopupEvent(payload)) {
                        return;
                    }

                    handlers.onModelSearchQueryChange?.(payload.query);
                }
            );
            unlisteners.push(unlisten);
        }

        if (handlers.onSessionOpen) {
            const unlisten = await eventService.on(AppEvent.POPUP_SESSION_OPEN, (payload) => {
                if (!this.isCurrentPopupEvent(payload)) {
                    return;
                }

                handlers.onSessionOpen?.(payload.sessionId);
            });
            unlisteners.push(unlisten);
        }

        if (handlers.onSessionSearchQueryChange) {
            const unlisten = await eventService.on(
                AppEvent.POPUP_SESSION_SEARCH_QUERY_CHANGE,
                (payload) => {
                    if (!this.isCurrentPopupEvent(payload)) {
                        return;
                    }

                    handlers.onSessionSearchQueryChange?.(payload.query);
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
            currentPopupId: this.currentPopupId,
            currentWindowLabel: this.currentWindowLabel,
            currentPopupSessionVersion: this.currentPopupSessionVersion,
            isInitialized: this.isInitialized,
        };
    }

    private async showPopupWindow(
        type: PopupType,
        position: PopupPosition,
        identity: {
            popupId: string;
            popupSessionVersion: number;
            windowLabel: string;
        }
    ): Promise<void> {
        await native.window.showPopupWindow({
            x: position.x,
            y: position.y,
            width: position.width,
            height: position.height,
            popupType: type,
            ...identity,
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


    /**
     * popup 关闭既可能来自主窗口的 hide，也可能来自 popup 自己触发的 close；
     * 两条路径都必须统一作废当前代次，避免过期恢复任务在关闭后再次拉起窗口。
     */
    private finalizePopupClosed(payload: PopupClosedPayload): void {
        if (
            this.currentType !== payload.type ||
            this.currentPopupId !== payload.popupId ||
            this.currentWindowLabel !== payload.windowLabel ||
            this.currentPopupSessionVersion !== payload.popupSessionVersion
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
        this.currentPopupSessionVersion = null;
        this.isOpen = false;
        this.currentType = null;
    }

    private getCurrentPopupClosedPayload(): PopupClosedPayload | null {
        if (
            !this.currentType ||
            !this.currentPopupId ||
            !this.currentWindowLabel ||
            this.currentPopupSessionVersion === null
        ) {
            return null;
        }

        return {
            popupId: this.currentPopupId,
            popupSessionVersion: this.currentPopupSessionVersion,
            type: this.currentType,
            windowLabel: this.currentWindowLabel,
        };
    }

    private getPopupClosedPayloadForIdentity(
        identity: PopupSessionIdentity
    ): PopupClosedPayload | null {
        if (
            this.currentPopupId !== identity.popupId ||
            this.currentWindowLabel !== identity.windowLabel ||
            this.currentPopupSessionVersion !== identity.popupSessionVersion ||
            !this.currentType
        ) {
            return null;
        }

        return {
            popupId: identity.popupId,
            popupSessionVersion: identity.popupSessionVersion,
            type: this.currentType,
            windowLabel: identity.windowLabel,
        };
    }

    private resetCurrentPopupState(popupId: string): void {
        if (this.currentPopupId !== popupId) {
            return;
        }

        this.currentPopupId = null;
        this.currentWindowLabel = null;
        this.currentPopupSessionVersion = null;
        this.currentType = null;
        this.isOpen = false;
    }

    private getWindowLabel(type: PopupType): string {
        return `popup-${type}`;
    }

    private buildPopupId(windowLabel: string, popupSessionVersion: number): string {
        return `${windowLabel}:${popupSessionVersion}`;
    }

    /**
     * 只接受命中当前 popup 会话的跨窗口事件，避免迟到事件污染新会话。
     */
    private isCurrentPopupEvent(payload: {
        popupId: string;
        windowLabel: string;
        popupSessionVersion: number;
    }): boolean {
        return (
            this.currentPopupId === payload.popupId &&
            this.currentWindowLabel === payload.windowLabel &&
            this.currentPopupSessionVersion === payload.popupSessionVersion
        );
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
            height: config.height,
        };
    }
}

// 导出单例
export const popupManager = new PopupManager();
