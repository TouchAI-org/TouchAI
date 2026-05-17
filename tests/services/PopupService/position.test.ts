import { createPopupPositionCalculator } from '@services/PopupService/position';
import type { PopupConfig, WindowInfo } from '@services/PopupService/types';
import { describe, expect, it, vi } from 'vitest';

function createWindowInfo(): WindowInfo {
    return {
        position: { x: 100, y: 200 },
        size: { width: 960, height: 720 },
        innerSize: { width: 920, height: 680 },
        scaleFactor: 1,
        screenSize: { width: 1920, height: 1080 },
        screenPosition: { x: 0, y: 0 },
    };
}

describe('createPopupPositionCalculator', () => {
    it('returns popup coordinates and dimensions from the registered popup calculator', async () => {
        const triggerElement = document.createElement('button');
        const windowInfo = createWindowInfo();
        const calculatePosition = vi.fn(() => ({ x: 180, y: 260 }));
        const config: PopupConfig = {
            id: 'session-history-popup',
            width: 320,
            height: 384,
            component: {} as PopupConfig['component'],
            calculatePosition,
        };

        const calculator = createPopupPositionCalculator({
            getPopupConfig: () => config,
            getWindowInfo: vi.fn().mockResolvedValue(windowInfo),
        });

        const position = await calculator.calculate('session-history-popup', triggerElement);

        expect(calculatePosition).toHaveBeenCalledWith(triggerElement, windowInfo, {
            width: 320,
            height: 384,
        });
        expect(position).toEqual({
            x: 180,
            y: 260,
            width: 320,
            height: 384,
        });
    });

    it('throws a descriptive error when the popup type is not registered', async () => {
        const calculator = createPopupPositionCalculator({
            getPopupConfig: () => undefined,
            getWindowInfo: vi.fn(),
        });

        await expect(
            calculator.calculate('model-dropdown-popup', document.createElement('button'))
        ).rejects.toThrow("[PopupManager] Popup type 'model-dropdown-popup' not registered");
    });
});
