// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { emit, listen, once as tauriOnce, type UnlistenFn } from '@tauri-apps/api/event';

import type { AppEventMap, AppEventName } from './types';

/**
 * 跨窗口事件服务
 */
class EventService {
    /**
     * 向所有窗口发送事件
     *
     * @param eventName - 要发送的事件名称（使用 AppEvent 枚举）
     * @param payload - 事件 payload
     */
    async emit<T extends AppEventName>(eventName: T, payload: AppEventMap[T]): Promise<void> {
        try {
            await emit(eventName, payload);
        } catch (error) {
            console.error(`发送事件 "${eventName}" 失败:`, error);
            throw error;
        }
    }

    /**
     * 监听来自任何窗口的事件
     *
     * @param eventName - 要监听的事件名称（使用 AppEvent 枚举）
     * @param callback - 接收到事件时调用的回调函数
     * @returns 取消监听的函数
     */
    async on<T extends AppEventName>(
        eventName: T,
        callback: (payload: AppEventMap[T]) => void
    ): Promise<UnlistenFn> {
        try {
            return await listen<AppEventMap[T]>(eventName, (event) => {
                callback(event.payload);
            });
        } catch (error) {
            console.error(`监听事件 "${eventName}" 失败:`, error);
            throw error;
        }
    }

    /**
     * 监听事件一次（首次调用后自动取消监听）
     *
     * @param eventName - 要监听的事件名称（使用 AppEvent 枚举）
     * @param callback - 接收到事件时调用的回调函数
     * @returns 取消监听的函数（如果想在触发前取消）
     */
    async once<T extends AppEventName>(
        eventName: T,
        callback: (payload: AppEventMap[T]) => void
    ): Promise<UnlistenFn> {
        try {
            return await tauriOnce<AppEventMap[T]>(eventName, (event) => {
                callback(event.payload);
            });
        } catch (error) {
            console.error(`监听一次性事件 "${eventName}" 失败:`, error);
            throw error;
        }
    }
}

// 单例实例
export const eventService = new EventService();

// 为方便起见重新导出类型和枚举
export type {
    AppEventMap,
    AppEventName,
    FontReadyEvent,
    GeneralSettingKey,
    McpServerStatus,
    McpStatusChangeEvent,
    SettingsGeneralUpdatedEvent,
    WindowFocusEvent,
    WindowResizeEvent,
} from './types';
export { AppEvent } from './types';
