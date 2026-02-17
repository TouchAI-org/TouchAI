// Copyright (c) 2026. 千诚. Licensed under GPL v3

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

    // 窗口事件
    WINDOW_FOCUS = 'window:focus',
    WINDOW_RESIZE = 'window:resize',
}

// ==================== MCP 事件 ====================

export type McpServerStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface McpStatusChangeEvent {
    serverId: number;
    status: McpServerStatus;
    error?: string;
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

// ==================== 事件映射 ====================

/**
 * 事件注册表，将事件名称映射到其 payload 类型
 */
export interface AppEventMap {
    // MCP 事件
    [AppEvent.MCP_STATUS]: McpStatusChangeEvent;

    // 窗口事件
    [AppEvent.WINDOW_FOCUS]: WindowFocusEvent;
    [AppEvent.WINDOW_RESIZE]: WindowResizeEvent;
}

export type AppEventName = keyof AppEventMap;
