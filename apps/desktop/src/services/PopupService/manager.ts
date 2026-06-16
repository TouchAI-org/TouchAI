// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { AppEvent, eventService } from '@services/EventService';
import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { createPopupPositionCalculator } from './position';
import { initializeBuiltInPopups, popupRegistry } from './registry';
import { createPopupSessionState, type PopupSessionState } from './sessionState';
import { createPopupTransport } from './transport';
import type {
    PopupClosedPayload,
    PopupData,
    PopupEventHandlers,
    PopupSessionIdentity,
    PopupType,
    WindowInfo,
} from './types';

async function getCurrentWindowInfo(): Promise<WindowInfo> {
    const mainWindow = getCurrentWindow();
    const scaleFactor = await mainWindow.scaleFactor();
    const mainPosition = (await mainWindow.outerPosition()).toLogical(scaleFactor);
    const mainSize = (await mainWindow.outerSize()).toLogical(scaleFactor);
    const innerSize = (await mainWindow.innerSize()).toLogical(scaleFactor);

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

    return {
        position: { x: mainPosition.x, y: mainPosition.y },
        size: { width: mainSize.width, height: mainSize.height },
        innerSize: { width: innerSize.width, height: innerSize.height },
        scaleFactor,
        screenSize,
        screenPosition,
    };
}

interface PopupManagerOptions {
    sessionState?: PopupSessionState;
    transport?: ReturnType<typeof createPopupTransport>;
    positionCalculator?: ReturnType<typeof createPopupPositionCalculator>;
}

/**
 * Popup 管理器
 * 负责 popup 窗口的初始化、显示、隐藏和事件管理
 */
export class PopupManager {
    private isInitialized = false;
    private isInitializing = false;
    private readyListenerInitialized = false;
    private readonly sessionState: PopupSessionState;
    private readonly transport: ReturnType<typeof createPopupTransport>;
    private readonly positionCalculator: ReturnType<typeof createPopupPositionCalculator>;

    constructor(options: PopupManagerOptions = {}) {
        this.sessionState = options.sessionState ?? createPopupSessionState();
        this.transport =
            options.transport ??
            createPopupTransport({
                emit: (event, payload) => eventService.emit(event, payload),
                registerPopupConfigs: (configs) => native.window.registerPopupConfigs(configs),
                preloadPopupWindows: () => native.window.preloadPopupWindows(),
                showPopupWindow: (params) => native.window.showPopupWindow(params),
                hidePopupWindow: (params) => native.window.hidePopupWindow(params),
            });
        this.positionCalculator =
            options.positionCalculator ??
            createPopupPositionCalculator({
                getPopupConfig: (type) => popupRegistry.get(type),
                getWindowInfo: getCurrentWindowInfo,
            });
    }

    private async ensureReadyListener(): Promise<void> {
        if (this.readyListenerInitialized) {
            return;
        }

        await eventService.on(AppEvent.POPUP_READY, ({ windowLabel }) => {
            const pendingPayload = this.sessionState.markWindowReady(windowLabel);
            if (!pendingPayload) {
                return;
            }

            void this.transport.emitPopupData(pendingPayload).catch((error) => {
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
            await this.transport.preloadWindows();

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
        const session = this.sessionState.openSession(type);

        try {
            if (!this.isInitialized) {
                await this.initialize();
            } else {
                // show 前先同步 popup 配置，确保原生注册表与前端声明的 popup 类型保持一致。
                await this.syncPopupConfigs();
            }

            const position = await this.positionCalculator.calculate(type, triggerElement);
            await this.transport.showWindow({
                popupId: session.popupId,
                popupSessionVersion: session.popupSessionVersion,
                popupType: type,
                windowLabel: session.windowLabel,
                ...position,
            });

            // isShow: true 标记此事件为弹窗首次展示。
            // 原生窗口显示由 PopupManager.show() 单点负责，避免跨窗口 resize/show 竞态。
            await this.transport.emitPopupData(
                this.sessionState.preparePopupData({
                    popupId: session.popupId,
                    popupSessionVersion: session.popupSessionVersion,
                    type,
                    data,
                    windowLabel: session.windowLabel,
                    isShow: true,
                })
            );
            return session.popupId;
        } catch (error) {
            this.sessionState.resetCurrentSession(session.popupId);
            console.error('[PopupManager] Failed to show popup:', error);
            throw error;
        }
    }

    /**
     * 隐藏弹窗
     */
    async hide(identity?: PopupSessionIdentity): Promise<void> {
        try {
            const closePayload = this.sessionState.getClosePayload(identity);
            if (!closePayload) {
                return;
            }
            await this.transport.hideWindow({
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
        const managerState = this.sessionState.snapshot();
        if (
            !managerState.isOpen ||
            !managerState.currentType ||
            !managerState.currentPopupId ||
            !managerState.currentWindowLabel ||
            managerState.currentPopupSessionVersion === null
        ) {
            return;
        }

        try {
            await this.transport.emitPopupData(
                this.sessionState.preparePopupData({
                    popupId: managerState.currentPopupId,
                    popupSessionVersion: managerState.currentPopupSessionVersion,
                    type: managerState.currentType,
                    data,
                    windowLabel: managerState.currentWindowLabel,
                })
            );
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
                if (!this.sessionState.isCurrentPopupEvent(payload)) {
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
                    if (!this.sessionState.isCurrentPopupEvent(payload)) {
                        return;
                    }

                    handlers.onModelSearchQueryChange?.(payload.query);
                }
            );
            unlisteners.push(unlisten);
        }

        if (handlers.onSessionOpen) {
            const unlisten = await eventService.on(AppEvent.POPUP_SESSION_OPEN, (payload) => {
                if (!this.sessionState.isCurrentPopupEvent(payload)) {
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
                    if (!this.sessionState.isCurrentPopupEvent(payload)) {
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
            ...this.sessionState.snapshot(),
            isInitialized: this.isInitialized,
        };
    }

    /**
     * popup 关闭既可能来自主窗口的 hide，也可能来自 popup 自己触发的 close；
     * 两条路径都必须统一作废当前代次，避免过期恢复任务在关闭后再次拉起窗口。
     */
    private finalizePopupClosed(payload: PopupClosedPayload): void {
        this.sessionState.finalizeClosed(payload);
    }

    private async syncPopupConfigs(): Promise<void> {
        initializeBuiltInPopups();

        const configs = popupRegistry.getSerializableConfig();
        if (configs.length === 0) {
            throw new Error('No popup configs available');
        }

        await this.transport.registerConfigs(configs);
    }
}

export function createPopupManager() {
    return new PopupManager();
}

// 导出单例
export const popupManager = createPopupManager();
