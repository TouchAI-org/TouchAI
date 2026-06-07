// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { Component } from 'vue';

import { POPUP_MANIFEST, type PopupType } from '@/contracts/popupManifest';

import ModelDropdownPopup from './components/ModelDropdownPopup/index.vue';
import SessionHistoryPopover from './components/SessionHistoryPopover/index.vue';

const popupComponents = {
    [POPUP_MANIFEST.modelDropdown.id]: ModelDropdownPopup,
    [POPUP_MANIFEST.sessionHistory.id]: SessionHistoryPopover,
} satisfies Record<PopupType, Component>;

export function getPopupComponent(type: PopupType): Component {
    return popupComponents[type];
}
