import { AppEvent } from '@services/EventService';
import type { HidePopupWindowParams, ShowPopupWindowParams } from '@services/NativeService/types';

import type { PopupDataPayload, SerializablePopupConfig } from './types';

interface PopupTransportOptions {
    emit: (event: AppEvent, payload: PopupDataPayload) => Promise<void>;
    registerPopupConfigs: (configs: SerializablePopupConfig[]) => Promise<void>;
    preloadPopupWindows: () => Promise<void>;
    showPopupWindow: (params: ShowPopupWindowParams) => Promise<void>;
    hidePopupWindow: (params: HidePopupWindowParams) => Promise<void>;
}

export function createPopupTransport(options: PopupTransportOptions) {
    const { emit, registerPopupConfigs, preloadPopupWindows, showPopupWindow, hidePopupWindow } =
        options;

    return {
        registerConfigs(configs: SerializablePopupConfig[]) {
            return registerPopupConfigs(configs);
        },
        preloadWindows() {
            return preloadPopupWindows();
        },
        showWindow(params: ShowPopupWindowParams) {
            return showPopupWindow(params);
        },
        emitPopupData(payload: PopupDataPayload) {
            return emit(AppEvent.POPUP_DATA, payload);
        },
        hideWindow(params: HidePopupWindowParams) {
            return hidePopupWindow(params);
        },
    };
}
