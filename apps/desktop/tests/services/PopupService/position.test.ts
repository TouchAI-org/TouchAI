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

describe('user opens a popup anchored to the search bar', () => {
    it('user gets the popup placed at the computed coordinates with its configured size', async () => {
        const triggerElement = document.createElement('button');
        const windowInfo = createWindowInfo();
        const config: PopupConfig = {
            id: 'session-history-popup',
            width: 320,
            height: 384,
            component: {} as PopupConfig['component'],
            calculatePosition: () => ({ x: 180, y: 260 }),
        };

        const calculator = createPopupPositionCalculator({
            getPopupConfig: () => config,
            getWindowInfo: vi.fn().mockResolvedValue(windowInfo),
        });

        await expect(
            calculator.calculate('session-history-popup', triggerElement)
        ).resolves.toEqual({
            x: 180,
            y: 260,
            width: 320,
            height: 384,
        });
    });

    it('user is told when a popup type was never registered', async () => {
        const calculator = createPopupPositionCalculator({
            getPopupConfig: () => undefined,
            getWindowInfo: vi.fn(),
        });

        await expect(
            calculator.calculate('model-dropdown-popup', document.createElement('button'))
        ).rejects.toThrow("[PopupManager] Popup type 'model-dropdown-popup' not registered");
    });
});
