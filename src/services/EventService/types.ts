// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type {
    PopupClosedPayload,
    PopupDataPayload,
    PopupFocusMainPayload,
    PopupKeydownPayload,
    PopupModelSelectPayload,
    PopupReadyPayload,
    PopupSessionOpenPayload,
    PopupSessionSearchQueryChangePayload,
} from '@services/PopupService/types';

/**
 * 事件类型定义
 *
 * 所有应用级事件都在这里定义，以确保类型安全。
 */

// ==================== 事件名称枚举 ====================

/**
 * 应用事件名称枚举
 * 使用这些常量而不是硬编码字符串
 */
export enum AppEvent {
    // MCP 事件
    MCP_STATUS = 'mcp:status',

    // 设置事件
    SETTINGS_GENERAL_UPDATED = 'settings:general-updated',

    // 窗口事件
    WINDOW_FOCUS = 'window:focus',
    WINDOW_RESIZE = 'window:resize',

    // 资源事件
    FONT_READY = 'font:ready',

    // Popup 事件
    POPUP_READY = 'popup-ready',
    POPUP_DATA = 'popup-data',
    POPUP_CLOSED = 'popup-closed',
    POPUP_KEYDOWN = 'popup-keydown',
    POPUP_MODEL_SELECT = 'popup-model-select',
    POPUP_SESSION_OPEN = 'popup-session-history-open-session',
    POPUP_SESSION_SEARCH_QUERY_CHANGE = 'popup-session-history-search-query-change',
    POPUP_FOCUS_MAIN = 'popup-focus-main',
}

// ==================== MCP 事件 ====================

export type McpServerStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface McpStatusChangeEvent {
    serverId: number;
    status: McpServerStatus;
    error?: string;
}

// ==================== 设置事件 ====================

export type GeneralSettingKey =
    | 'global_shortcut'
    | 'start_on_boot'
    | 'start_minimized'
    | 'mcp_max_iterations'
    | 'output_scroll_behavior';

export interface SettingsGeneralUpdatedEvent {
    sourceId: string;
    windowLabel: string;
    key: GeneralSettingKey;
    value: string | number | boolean;
}

// ==================== 窗口事件 ====================

export interface WindowFocusEvent {
    windowLabel: string;
    focused: boolean;
}

export interface WindowResizeEvent {
    windowLabel: string;
    width: number;
    height: number;
}

// ==================== 资源事件 ====================

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FontReadyEvent {
    // 空 payload，仅作为通知
}

// ==================== 事件映射 ====================

/**
 * 事件注册表，将事件名称映射到其 payload 类型
 */
export interface AppEventMap {
    // MCP 事件
    [AppEvent.MCP_STATUS]: McpStatusChangeEvent;

    // 设置事件
    [AppEvent.SETTINGS_GENERAL_UPDATED]: SettingsGeneralUpdatedEvent;

    // 窗口事件
    [AppEvent.WINDOW_FOCUS]: WindowFocusEvent;
    [AppEvent.WINDOW_RESIZE]: WindowResizeEvent;

    // 资源事件
    [AppEvent.FONT_READY]: FontReadyEvent;

    // Popup 事件
    [AppEvent.POPUP_READY]: PopupReadyPayload;
    [AppEvent.POPUP_DATA]: PopupDataPayload;
    [AppEvent.POPUP_CLOSED]: PopupClosedPayload;
    [AppEvent.POPUP_KEYDOWN]: PopupKeydownPayload;
    [AppEvent.POPUP_MODEL_SELECT]: PopupModelSelectPayload;
    [AppEvent.POPUP_SESSION_OPEN]: PopupSessionOpenPayload;
    [AppEvent.POPUP_SESSION_SEARCH_QUERY_CHANGE]: PopupSessionSearchQueryChangePayload;
    [AppEvent.POPUP_FOCUS_MAIN]: PopupFocusMainPayload;
}

export type AppEventName = keyof AppEventMap;
