export interface PopupConfig {
    id: string;
    width: number;
    height: number;
}

export interface ShowPopupWindowParams {
    x: number;
    y: number;
    width: number;
    height: number;
    popupType: string;
}

export interface TauriLogPayload {
    level: number;
    message: string;
    location?: string;
    file?: string;
    line?: number;
}
