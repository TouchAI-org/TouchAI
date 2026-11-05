import type { popupRegistry } from './registry';
import { POPUP_WINDOW_GUTTER, type PopupPosition, type PopupType, type WindowInfo } from './types';

interface PopupPositionCalculatorOptions {
    getPopupConfig: typeof popupRegistry.get;
    getWindowInfo: () => Promise<WindowInfo>;
}

export function createPopupPositionCalculator(options: PopupPositionCalculatorOptions) {
    const { getPopupConfig, getWindowInfo } = options;

    async function calculate(type: PopupType, triggerElement: HTMLElement): Promise<PopupPosition> {
        const config = getPopupConfig(type);
        if (!config) {
            throw new Error(`[PopupManager] Popup type '${type}' not registered`);
        }

        const windowInfo = await getWindowInfo();
        const dimensions = { width: config.width, height: config.height };
        const position = config.calculatePosition(triggerElement, windowInfo, dimensions);

        return {
            x: position.x - POPUP_WINDOW_GUTTER,
            y: position.y - POPUP_WINDOW_GUTTER,
            width: config.width + POPUP_WINDOW_GUTTER * 2,
            height: config.height + POPUP_WINDOW_GUTTER * 2,
        };
    }

    return {
        calculate,
    };
}
