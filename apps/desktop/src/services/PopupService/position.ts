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
        const width = config.width + POPUP_WINDOW_GUTTER * 2;
        const height = config.height + POPUP_WINDOW_GUTTER * 2;
        let x = position.x - POPUP_WINDOW_GUTTER;
        let y = position.y - POPUP_WINDOW_GUTTER;

        if (windowInfo.screenSize && windowInfo.screenPosition) {
            const minX = windowInfo.screenPosition.x;
            const minY = windowInfo.screenPosition.y;
            const screenRight = minX + windowInfo.screenSize.width;
            const screenBottom = minY + windowInfo.screenSize.height;

            x =
                width <= windowInfo.screenSize.width
                    ? Math.max(minX, Math.min(x, screenRight - width))
                    : Math.max(minX, Math.min(position.x, screenRight - config.width)) -
                      POPUP_WINDOW_GUTTER;
            y =
                height <= windowInfo.screenSize.height
                    ? Math.max(minY, Math.min(y, screenBottom - height))
                    : Math.max(minY, Math.min(position.y, screenBottom - config.height)) -
                      POPUP_WINDOW_GUTTER;
        }

        return {
            x,
            y,
            width,
            height,
        };
    }

    return {
        calculate,
    };
}
