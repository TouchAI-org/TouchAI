import { describe, expect, it, vi } from 'vitest';

const { endMock } = vi.hoisted(() => ({ endMock: vi.fn() }));

vi.mock('@/utils/perfTrace', () => ({
    createPerfTrace: vi.fn(() => ({ end: endMock })),
}));

vi.mock('@services/EventService', () => ({
    AppEvent: { POPUP_CLOSED: 'popup-closed' },
    eventService: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('@services/NativeService', () => ({ native: {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));

import { PopupManager } from '@/services/PopupService/manager';

function createManager(overrides: {
    initialize?: () => Promise<void>;
    showWindow?: () => Promise<void>;
    emitPopupData?: () => Promise<void>;
    calculate?: () => Promise<{ x: number; y: number; width: number; height: number }>;
}) {
    const manager = Object.create(PopupManager.prototype) as PopupManager & Record<string, unknown>;
    Object.assign(manager, {
        isInitialized: true,
        sessionState: {
            openSession: vi.fn(() => ({
                popupId: 'popup-1',
                popupSessionVersion: 1,
                windowLabel: 'popup-1',
            })),
            preparePopupData: vi.fn(() => ({})),
            resetCurrentSession: vi.fn(),
        },
        syncPopupConfigs: vi.fn(async () => undefined),
        positionCalculator: {
            calculate:
                overrides.calculate ?? vi.fn(async () => ({ x: 0, y: 0, width: 1, height: 1 })),
        },
        transport: {
            showWindow: overrides.showWindow ?? vi.fn(async () => undefined),
            emitPopupData: overrides.emitPopupData ?? vi.fn(async () => undefined),
        },
        initialize: overrides.initialize ?? vi.fn(async () => undefined),
    });
    return manager;
}

describe('PopupManager show instrumentation', () => {
    it('records a warm popup show', async () => {
        endMock.mockClear();
        const manager = createManager({});

        await manager.show('session-history-popup', document.createElement('div'), {} as never);

        expect(endMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'session-history-popup', cold: false })
        );
    });

    it('marks the first show after initialization as cold', async () => {
        endMock.mockClear();
        const manager = createManager({});
        (manager as unknown as { isInitialized: boolean }).isInitialized = false;

        await manager.show('session-history-popup', document.createElement('div'), {} as never);

        expect(endMock).toHaveBeenCalledWith(expect.objectContaining({ cold: true }));
    });

    it('does not record a sample when showing fails', async () => {
        endMock.mockClear();
        const manager = createManager({
            showWindow: vi.fn(async () => {
                throw new Error('show failed');
            }),
        });

        await expect(
            manager.show('session-history-popup', document.createElement('div'), {} as never)
        ).rejects.toThrow('show failed');
        expect(endMock).not.toHaveBeenCalled();
    });
});
