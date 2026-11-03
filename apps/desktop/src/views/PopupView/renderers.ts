// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { PopupType } from '@services/PopupService';
import type { Component } from 'vue';

import ModelDropdownPopup from './components/ModelDropdownPopup/index.vue';
import SessionHistoryPopover from './components/SessionHistoryPopover/index.vue';

/**
 * Popup id → Vue 渲染组件的映射。
 *
 * 组件注册属于视图层：`PopupService` 只声明窗口清单与几何，
 * 由 PopupView 在自己的组合阶段把 id 解析成实际组件。
 */
const popupRenderers: Record<PopupType, Component> = {
    'model-dropdown-popup': ModelDropdownPopup,
    'session-history-popup': SessionHistoryPopover,
};

export function getPopupRenderer(type: PopupType): Component | null {
    return popupRenderers[type] ?? null;
}
