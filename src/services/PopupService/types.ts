// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { Component } from 'vue';

/**
 * 弹窗窗口内容类型
 */
export type PopupType = 'model-dropdown-popup' | 'attachment-overflow-popup';

/**
 * 窗口信息，用于位置计算
 */
export interface WindowInfo {
    position: { x: number; y: number };
    size: { width: number; height: number };
    innerSize: { width: number; height: number };
    scaleFactor: number;
    screenSize?: { width: number; height: number }; // 屏幕尺寸
    screenPosition?: { x: number; y: number }; // 屏幕位置
}

/**
 * 位置计算函数类型
 */
export type PositionCalculator = (
    triggerElement: HTMLElement,
    mainWindow: WindowInfo,
    dimensions: { width: number; height: number }
) => { x: number; y: number };

/**
 * Popup 配置接口
 */
export interface PopupConfig<TData = unknown> {
    /** 唯一标识符 */
    id: PopupType;
    /** 窗口宽度（逻辑像素） */
    width: number;
    /** 窗口高度（逻辑像素） */
    height: number;
    /** 窗口最小高度（逻辑像素），用于内容不足时保持最低高度 */
    minHeight?: number;
    /** Vue 组件 */
    component: Component;
    /** 位置计算函数 */
    calculatePosition: PositionCalculator;
    /** 可选的数据验证器 */
    dataValidator?: (data: unknown) => data is TData;
}

/**
 * 可序列化的 Popup 配置（用于传递给 Rust）
 */
export interface SerializablePopupConfig {
    id: string;
    width: number;
    height: number;
}

/**
 * 弹窗窗口位置和大小
 */
export interface PopupPosition {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 模型下拉框弹窗数据
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
 * 模型下拉框弹窗项数据（从父窗口传递）
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

/**
 * 附件溢出弹窗数据
 */
export interface AttachmentListData {
    attachments: Array<{
        id: string;
        name: string;
        path: string;
        type: 'image' | 'file';
        size?: number;
        preview?: string;
        mimeType?: string;
        supportStatus?: 'supported' | 'unsupported-image' | 'unsupported-file';
    }>;
}

/**
 * 弹窗数据联合类型
 */
export type PopupData = ModelDropdownData | AttachmentListData;

/**
 * 根据 PopupType 获取对应的数据类型
 */
export type PopupDataFor<T extends PopupType> = T extends 'model-dropdown-popup'
    ? ModelDropdownData
    : T extends 'attachment-overflow-popup'
      ? AttachmentListData
      : never;

/**
 * 弹窗数据更新事件载荷
 */
export interface PopupDataPayload {
    type: PopupType;
    data: PopupData;
    windowLabel?: string;
}

/**
 * 弹窗事件处理器
 */
export interface PopupEventHandlers {
    onModelSelect?: (modelDbId: number) => void;
    onAttachmentAction?: (action: 'remove' | 'preview', attachmentId: string) => void;
    onClose?: () => void;
}
