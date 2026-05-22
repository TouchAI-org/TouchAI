import type { popupRegistry } from './registry';
import type { PopupPosition, PopupType, WindowInfo } from './types';

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
            x: position.x,
            y: position.y,
            width: config.width,
            height: config.height,
        };
    }

    return {
        calculate,
    };
}
