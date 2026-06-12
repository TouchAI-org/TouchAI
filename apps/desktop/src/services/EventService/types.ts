// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type {
    PopupClosedPayload,
    PopupDataPayload,
    PopupKeydownPayload,
    PopupModelSearchQueryChangePayload,
    PopupModelSelectPayload,
    PopupReadyPayload,
    PopupSessionOpenPayload,
    PopupSessionSearchQueryChangePayload,
} from '@services/PopupService/types';

import type { GeneralSettingKey, GeneralSettingValue } from '@/stores/setting';
import type { SessionStatusReminderKind } from '@/utils/session';

export type { GeneralSettingKey, GeneralSettingValue } from '@/stores/setting';
export type { SessionStatusReminderKind } from '@/utils/session';

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
    SETTINGS_AI_SERVICES_FOCUS_PROVIDER = 'settings:ai-services:focus-provider',
    AI_MODELS_UPDATED = 'ai-models:updated',

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
    POPUP_MODEL_SEARCH_QUERY_CHANGE = 'popup-model-search-query-change',
    POPUP_SESSION_OPEN = 'popup-session-history-open-session',
    POPUP_SESSION_SEARCH_QUERY_CHANGE = 'popup-session-history-search-query-change',
    SEARCH_SURFACE_SHOWN = 'search-surface-shown',
    SEARCH_SURFACE_HIDDEN = 'search-surface-hidden',
    SEARCH_SURFACE_COMMAND = 'search-surface-command',
    SESSION_TASK_STATUS_CHANGED = 'session:task:status-changed',
    SESSION_STATUS_REMINDER_ACTION = 'session-status-reminder:action',

    // 快捷键捕获事件
    SHORTCUT_CAPTURE_SYSTEM_KEY = 'shortcut-capture-system-key',
}

// ==================== MCP 事件 ====================

export type McpServerStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface McpStatusChangeEvent {
    serverId: number;
    status: McpServerStatus;
    error?: string;
}

// ==================== 设置事件 ====================

export interface SettingsGeneralUpdatedEvent {
    sourceId: string;
    windowLabel: string;
    key: GeneralSettingKey;
    value: GeneralSettingValue;
}

export interface SettingsAiServicesFocusProviderEvent {
    section: 'ai-services';
    providerDriver: 'mimo';
    requireBuiltIn: true;
    mode: 'managed';
    reason: 'managed-auth-callback';
    requestedAt: number;
}

export interface AiModelsUpdatedEvent {
    updatedAt: number;
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

export interface SearchSurfaceShownEvent {
    source: 'shortcut' | 'notification';
    sequence?: number;
}

export interface SearchSurfaceHiddenEvent {
    reason: 'app-blur-hide' | 'manual-dismiss' | 'policy-toggle-hide';
    sequence?: number;
}

export interface SearchSurfaceCommandEvent {
    command: 'toggle-model-dropdown';
    source: 'webview2-accelerator';
}

/**
 * 系统级快捷键（如 Alt+Space）由 WebView2 当作 system accelerator 截获，
 * 不会派发 DOM keydown，因此宿主在 accelerator 阶段直接 emit 此事件，
 * 由前端在快捷键录入模式下监听并复用普通保存路径。
 */
export interface ShortcutCaptureSystemKeyEvent {
    key: 'Space';
    alt: boolean;
    ctrl: boolean;
    shift: boolean;
}

export interface SessionStatusReminderApprovalActionPayload {
    callId: string;
    approveLabel: string;
    rejectLabel: string;
}

export interface SessionStatusReminderPayload {
    kind: SessionStatusReminderKind;
    title: string;
    body: string;
    approval?: SessionStatusReminderApprovalActionPayload | null;
    replyPlaceholder?: string | null;
    replyLabel?: string | null;
}

export interface SessionStatusReminderActionEvent {
    sessionId: number;
    taskId: string;
    kind: SessionStatusReminderKind;
    action: 'open' | 'approve' | 'reject' | 'reply';
    callId?: string | null;
    replyText?: string | null;
}

// ==================== 资源事件 ====================

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FontReadyEvent {
    // 空 payload，仅作为通知
}

export interface SessionTaskStatusChangedEvent {
    sessionId: number;
    taskId: string;
    status: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
    previousStatus: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | null;
    reminder: SessionStatusReminderPayload | null;
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
    [AppEvent.SETTINGS_AI_SERVICES_FOCUS_PROVIDER]: SettingsAiServicesFocusProviderEvent;
    [AppEvent.AI_MODELS_UPDATED]: AiModelsUpdatedEvent;

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
    [AppEvent.POPUP_MODEL_SEARCH_QUERY_CHANGE]: PopupModelSearchQueryChangePayload;
    [AppEvent.POPUP_SESSION_OPEN]: PopupSessionOpenPayload;
    [AppEvent.POPUP_SESSION_SEARCH_QUERY_CHANGE]: PopupSessionSearchQueryChangePayload;
    [AppEvent.SEARCH_SURFACE_SHOWN]: SearchSurfaceShownEvent;
    [AppEvent.SEARCH_SURFACE_HIDDEN]: SearchSurfaceHiddenEvent;
    [AppEvent.SEARCH_SURFACE_COMMAND]: SearchSurfaceCommandEvent;
    [AppEvent.SESSION_TASK_STATUS_CHANGED]: SessionTaskStatusChangedEvent;
    [AppEvent.SESSION_STATUS_REMINDER_ACTION]: SessionStatusReminderActionEvent;

    // 快捷键捕获事件
    [AppEvent.SHORTCUT_CAPTURE_SYSTEM_KEY]: ShortcutCaptureSystemKeyEvent;
}

export type AppEventName = keyof AppEventMap;
