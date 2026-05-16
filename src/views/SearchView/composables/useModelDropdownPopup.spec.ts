import { type ModelDropdownData, popupManager } from '@services/PopupService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountComposable } from '../../../../tests/utils/composables';
import { useModelDropdownPopup } from './useModelDropdownPopup';

const { popupManagerMock, popupManagerState } = vi.hoisted(() => ({
    popupManagerState: {
        isOpen: true,
        currentType: 'model-dropdown-popup' as const,
        currentPopupId: 'popup-model-dropdown-popup:1',
        currentWindowLabel: 'popup-model-dropdown-popup',
        currentPopupSessionVersion: 1,
        isInitialized: true,
    },
    popupManagerMock: {
        show: vi.fn(),
        hide: vi.fn(),
        updateData: vi.fn(),
        listen: vi.fn(),
    },
}));

function createPopupData(overrides: Partial<ModelDropdownData> = {}): ModelDropdownData {
    return {
        activeModelId: 'gpt-5',
        activeProviderId: 1,
        selectedModelId: 'gpt-5',
        selectedProviderId: 1,
        searchQuery: '',
        models: [],
        ...overrides,
    };
}

vi.mock('@services/PopupService', () => ({
    popupManager: {
        ...popupManagerMock,
        state: popupManagerState,
    },
}));

describe('useModelDropdownPopup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.assign(popupManagerState, {
            isOpen: true,
            currentType: 'model-dropdown-popup',
            currentPopupId: 'popup-model-dropdown-popup:1',
            currentWindowLabel: 'popup-model-dropdown-popup',
            currentPopupSessionVersion: 1,
            isInitialized: true,
        });
        vi.mocked(popupManager.show).mockResolvedValue('popup-model-dropdown-popup:1');
        vi.mocked(popupManager.hide).mockResolvedValue(undefined);
        vi.mocked(popupManager.updateData).mockResolvedValue(undefined);
        vi.mocked(popupManager.listen).mockResolvedValue(() => undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('opens the popup and reports a live session when popupManager confirms the same session', async () => {
        const onPopupSessionStart = vi.fn();
        const mounted = await mountComposable(() =>
            useModelDropdownPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData({ searchQuery: 'model' }),
                isModelDropdownActive: () => true,
                onModelSelect: () => undefined,
                onModelSearchQueryChange: () => undefined,
                onClose: () => undefined,
                onPopupSessionStart,
            })
        );

        await mounted.result.open();

        expect(mounted.result.isOpen.value).toBe(true);
        expect(mounted.result.isLiveSession()).toBe(true);
        expect(onPopupSessionStart).toHaveBeenCalledWith({
            popupId: 'popup-model-dropdown-popup:1',
            windowLabel: 'popup-model-dropdown-popup',
            popupSessionVersion: 1,
        });

        mounted.unmount();
    });

    it('ignores stale popup close events and preserves the live session until the active popup closes', async () => {
        let onCloseListener:
            | ((payload: {
                  popupId: string;
                  popupSessionVersion: number;
                  windowLabel: string;
                  type: 'model-dropdown-popup';
              }) => void)
            | undefined;
        vi.mocked(popupManager.listen).mockImplementation(async (handlers) => {
            onCloseListener = handlers.onClose as typeof onCloseListener;
            return () => undefined;
        });
        const onClose = vi.fn();
        const onPopupSessionEnd = vi.fn();
        const mounted = await mountComposable(() =>
            useModelDropdownPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isModelDropdownActive: () => true,
                onModelSelect: () => undefined,
                onModelSearchQueryChange: () => undefined,
                onClose,
                onPopupSessionEnd,
            })
        );

        await mounted.result.open();

        onCloseListener?.({
            popupId: 'popup-model-dropdown-popup:99',
            popupSessionVersion: 99,
            windowLabel: 'popup-model-dropdown-popup',
            type: 'model-dropdown-popup',
        });

        expect(mounted.result.isOpen.value).toBe(true);
        expect(onClose).not.toHaveBeenCalled();

        onCloseListener?.({
            popupId: 'popup-model-dropdown-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-model-dropdown-popup',
            type: 'model-dropdown-popup',
        });

        expect(mounted.result.isOpen.value).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onPopupSessionEnd).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('closes the active popup session with the current identity', async () => {
        const onPopupSessionEnd = vi.fn();
        const mounted = await mountComposable(() =>
            useModelDropdownPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isModelDropdownActive: () => true,
                onModelSelect: () => undefined,
                onModelSearchQueryChange: () => undefined,
                onClose: () => undefined,
                onPopupSessionEnd,
            })
        );

        await mounted.result.open();
        await mounted.result.close();

        expect(popupManager.hide).toHaveBeenCalledWith({
            popupId: 'popup-model-dropdown-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-model-dropdown-popup',
        });
        expect(mounted.result.isOpen.value).toBe(false);
        expect(onPopupSessionEnd).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });
});
