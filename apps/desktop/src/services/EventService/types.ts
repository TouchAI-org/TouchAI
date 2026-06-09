// Copyright (c) 2026. 鍗冭瘹. Licensed under GPL v3

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
 * 浜嬩欢绫诲瀷瀹氫箟
 *
 * 鎵€鏈夊簲鐢ㄧ骇浜嬩欢閮藉湪杩欓噷瀹氫箟锛屼互纭繚绫诲瀷瀹夊叏銆? */

// ==================== 浜嬩欢鍚嶇О鏋氫妇 ====================

/**
 * 搴旂敤浜嬩欢鍚嶇О鏋氫妇
 * 浣跨敤杩欎簺甯搁噺鑰屼笉鏄‖缂栫爜瀛楃涓? */
export enum AppEvent {
    // MCP 浜嬩欢
    MCP_STATUS = 'mcp:status',

    // 璁剧疆浜嬩欢
    SETTINGS_GENERAL_UPDATED = 'settings:general-updated',
    SETTINGS_AI_SERVICES_FOCUS_PROVIDER = 'settings:ai-services:focus-provider',
    AI_MODELS_UPDATED = 'ai-models:updated',

    // 绐楀彛浜嬩欢
    WINDOW_FOCUS = 'window:focus',
    WINDOW_RESIZE = 'window:resize',

    // 璧勬簮浜嬩欢
    FONT_READY = 'font:ready',

    // Popup 浜嬩欢
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
}

// ==================== MCP 浜嬩欢 ====================

export type McpServerStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface McpStatusChangeEvent {
    serverId: number;
    status: McpServerStatus;
    error?: string;
}

// ==================== 璁剧疆浜嬩欢 ====================

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

// ==================== 绐楀彛浜嬩欢 ====================

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

// ==================== 璧勬簮浜嬩欢 ====================

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FontReadyEvent {
    // 绌?payload锛屼粎浣滀负閫氱煡
}

export interface SessionTaskStatusChangedEvent {
    sessionId: number;
    taskId: string;
    status: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
    previousStatus: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | null;
    reminder: SessionStatusReminderPayload | null;
}

// ==================== 浜嬩欢鏄犲皠 ====================

/**
 * 浜嬩欢娉ㄥ唽琛紝灏嗕簨浠跺悕绉版槧灏勫埌鍏?payload 绫诲瀷
 */
export interface AppEventMap {
    // MCP 浜嬩欢
    [AppEvent.MCP_STATUS]: McpStatusChangeEvent;

    // 璁剧疆浜嬩欢
    [AppEvent.SETTINGS_GENERAL_UPDATED]: SettingsGeneralUpdatedEvent;
    [AppEvent.SETTINGS_AI_SERVICES_FOCUS_PROVIDER]: SettingsAiServicesFocusProviderEvent;
    [AppEvent.AI_MODELS_UPDATED]: AiModelsUpdatedEvent;

    // 绐楀彛浜嬩欢
    [AppEvent.WINDOW_FOCUS]: WindowFocusEvent;
    [AppEvent.WINDOW_RESIZE]: WindowResizeEvent;

    // 璧勬簮浜嬩欢
    [AppEvent.FONT_READY]: FontReadyEvent;

    // Popup 浜嬩欢
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
}

export type AppEventName = keyof AppEventMap;
