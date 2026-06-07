// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { PopupType } from './popupManifest';

export type SessionHistoryDisplayStatus = 'running' | 'waiting_approval' | 'completed' | 'failed';

/**
 * 窗口信息，用于位置计算。
 */
export interface WindowInfo {
    position: { x: number; y: number };
    size: { width: number; height: number };
    innerSize: { width: number; height: number };
    scaleFactor: number;
    screenSize?: { width: number; height: number };
    screenPosition?: { x: number; y: number };
}

/**
 * 可序列化的 Popup 配置（用于传递给 Rust）。
 */
export interface SerializablePopupConfig {
    id: string;
    width: number;
    height: number;
}

/**
 * 弹窗窗口位置和大小。
 */
export interface PopupPosition {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 模型下拉框弹窗数据。
 */
export interface ModelDropdownData {
    activeModelId: string;
    activeProviderId: number | null;
    selectedModelId: string;
    selectedProviderId: number | null;
    searchQuery: string;
    models?: ModelDropdownPopupItem[];
}

/**
 * 模型下拉框弹窗项数据（从父窗口传递）。
 */
export interface ModelDropdownPopupItem {
    id: number;
    modelId: string;
    name: string;
    providerId: number;
    providerName: string;
    reasoning: number;
    tool_call: number;
    modalities: string | null;
    attachment: number;
    open_weights: number;
}

export interface SessionHistorySessionItem {
    id: number;
    session_id: string;
    title: string;
    model: string;
    provider_id: number | null;
    last_message_preview: string | null;
    last_message_at: string | null;
    message_count: number;
    status_badge_dismissed_turn_id: number | null;
    pending_terminal_status: 'completed' | 'failed' | null;
    pinned_at: string | null;
    archived_at: string | null;
    created_at: string;
    updated_at: string;
    displayStatus: SessionHistoryDisplayStatus | null;
}

/**
 * 历史会话弹窗数据。
 */
export interface SessionHistoryData {
    sessions: SessionHistorySessionItem[];
    activeSessionId: number | null;
    searchQuery: string;
    isLoading: boolean;
}

export type PopupData = ModelDropdownData | SessionHistoryData;

/**
 * 根据 PopupType 获取对应的数据类型。
 */
export type PopupDataFor<T extends PopupType> = T extends 'model-dropdown-popup'
    ? ModelDropdownData
    : T extends 'session-history-popup'
      ? SessionHistoryData
      : never;

export interface PopupSessionIdentity {
    popupId: string;
    windowLabel: string;
    popupSessionVersion: number;
}

export interface PopupClosedPayload extends PopupSessionIdentity {
    type: PopupType;
}

export interface PopupReadyPayload {
    windowLabel: string;
}

/**
 * 弹窗数据更新事件载荷。
 */
export interface PopupDataPayload extends PopupSessionIdentity {
    type: PopupType;
    data: PopupData;
    /**
     * true 表示弹窗首次展示（来自 show()），缺省/false 表示纯数据更新（来自 updateData()）。
     * 原生窗口显示由 PopupManager.show() 负责，PopupView 仅用它区分首次聚焦和普通数据刷新。
     */
    isShow?: boolean;
}

/**
 * 转发给特定 popup 窗口的键盘事件载荷。
 */
export interface PopupKeydownPayload {
    key: string;
    targetType: PopupType;
}

export interface PopupModelSelectPayload extends PopupSessionIdentity {
    modelDbId: number;
}

export interface PopupSessionOpenPayload extends PopupSessionIdentity {
    sessionId: number;
}

export interface PopupSessionSearchQueryChangePayload extends PopupSessionIdentity {
    query: string;
}

export interface PopupModelSearchQueryChangePayload extends PopupSessionIdentity {
    query: string;
}

/**
 * 弹窗事件处理器。
 */
export interface PopupEventHandlers {
    onModelSelect?: (modelDbId: number) => void;
    onModelSearchQueryChange?: (query: string) => void;
    onSessionOpen?: (sessionId: number) => void;
    onSessionSearchQueryChange?: (query: string) => void;
    onClose?: (payload: PopupClosedPayload) => void;
}
