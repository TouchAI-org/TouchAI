import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

/**
 * The model dropdown opens through a small command sequence so a layout shift in the page
 * cannot leave the popup anchored to a stale position. Each step is observable through the
 * controller calls and the dropdown state the page reads, which is what these tests assert.
 */
const popupState = vi.hoisted(() => ({
    isOpen: { value: false },
    open: vi.fn(),
    close: vi.fn(),
    updateData: vi.fn(),
    isLiveSession: vi.fn(),
}));

vi.mock('@/views/SearchView/composables/useModelDropdownPopup', () => ({
    useModelDropdownPopup: () => popupState,
}));

const { useSearchModelDropdownCoordinator } =
    await import('@/views/SearchView/composables/useSearchPage');

type Command = 'noop' | 'close-quick-search' | 'wait-layout-stable' | 'open-model-dropdown';

function createController() {
    return {
        getModelDropdownContext: vi.fn(() => ({
            activeModelId: 'model-active',
            activeProviderId: 1,
            selectedModelId: null,
            selectedProviderId: null,
            models: [
                { id: 'model-1', provider_id: 1, provider_enabled: 1, name: 'Alpha' },
                { id: 'model-2', provider_id: 2, provider_enabled: 0, name: 'Hidden' },
            ],
        })),
        getModelDropdownAnchor: vi.fn(() => null),
        prepareModelDropdownOpen: vi.fn(async () => undefined),
        selectModelFromDropdown: vi.fn(async () => ({ modelId: null, providerId: null })),
        closeQuickSearch: vi.fn(),
    };
}

function mountCoordinator(overrides: Record<string, unknown> = {}) {
    const controller = createController();
    const modelDropdownState = ref({ isOpen: false });
    const modelDropdownQuery = ref('');
    const handleModelDropdownOpened = vi.fn();
    const handleModelDropdownClosed = vi.fn();
    const syncOverlayState = vi.fn();

    return mountComposable(() =>
        useSearchModelDropdownCoordinator({
            pageContainer: ref(null),
            controller: controller as never,
            modelOverride: ref({ modelId: null, providerId: null }),
            modelDropdownState,
            modelDropdownQuery,
            getModelToggleShortcut: () => null,
            requestModelDropdownOpen: () => 'open-model-dropdown' as Command,
            handleQuickSearchClosedForModelDropdown: () => 'noop' as Command,
            handleLayoutStableForModelDropdown: () => 'noop' as Command,
            handleModelDropdownOpened,
            handleModelDropdownClosed,
            syncOverlayState,
            ...overrides,
        })
    ).then((mounted) => ({
        ...mounted.result,
        unmount: mounted.unmount,
        controller,
        modelDropdownState,
        modelDropdownQuery,
        handleModelDropdownOpened,
        handleModelDropdownClosed,
        syncOverlayState,
    }));
}

describe('user opens the model dropdown', () => {
    beforeEach(() => {
        popupState.open.mockReset();
        popupState.close.mockReset();
        popupState.updateData.mockReset();
        popupState.isLiveSession.mockReset();
        popupState.isOpen.value = false;
    });

    it('user sees the dropdown open after the page has prepared it', async () => {
        popupState.open.mockImplementation(async () => {
            popupState.isOpen.value = true;
        });
        const mounted = await mountCoordinator();

        await mounted.handleToggleModelDropdownRequest();

        expect(mounted.controller.prepareModelDropdownOpen).toHaveBeenCalled();
        expect(mounted.modelDropdownState.value.isOpen).toBe(true);
        expect(mounted.handleModelDropdownOpened).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user sees the dropdown stay closed when the popup refuses to open', async () => {
        popupState.open.mockImplementation(async () => {
            popupState.isOpen.value = false;
        });
        const mounted = await mountCoordinator();

        await mounted.handleToggleModelDropdownRequest();

        expect(mounted.modelDropdownState.value.isOpen).toBe(false);
        expect(mounted.handleModelDropdownClosed).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user sees the dropdown stay closed when opening it throws', async () => {
        popupState.open.mockRejectedValue(new Error('popup window refused'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const mounted = await mountCoordinator();

        await mounted.handleToggleModelDropdownRequest();

        expect(mounted.modelDropdownState.value.isOpen).toBe(false);
        expect(mounted.modelDropdownQuery.value).toBe('');
        expect(mounted.syncOverlayState).toHaveBeenCalled();

        consoleError.mockRestore();
        mounted.unmount();
    });

    it('user sees the quick search panel closed before the dropdown opens', async () => {
        popupState.open.mockImplementation(async () => {
            popupState.isOpen.value = true;
        });
        const mounted = await mountCoordinator({
            requestModelDropdownOpen: () => 'close-quick-search' as Command,
            handleQuickSearchClosedForModelDropdown: () => 'open-model-dropdown' as Command,
        });

        await mounted.handleToggleModelDropdownRequest();

        expect(mounted.controller.closeQuickSearch).toHaveBeenCalled();
        expect(mounted.modelDropdownState.value.isOpen).toBe(true);

        mounted.unmount();
    });

    it('user sees the dropdown open only after the layout settles', async () => {
        popupState.open.mockImplementation(async () => {
            popupState.isOpen.value = true;
        });
        const handleLayoutStableForModelDropdown = vi.fn(() => 'open-model-dropdown' as Command);
        const mounted = await mountCoordinator({
            requestModelDropdownOpen: () => 'wait-layout-stable' as Command,
            handleLayoutStableForModelDropdown,
        });

        await mounted.handleToggleModelDropdownRequest();

        expect(handleLayoutStableForModelDropdown).toHaveBeenCalled();
        expect(mounted.modelDropdownState.value.isOpen).toBe(true);

        mounted.unmount();
    });

    it('user gets nothing opened when the request resolves to noop', async () => {
        const mounted = await mountCoordinator({
            requestModelDropdownOpen: () => 'noop' as Command,
        });

        await mounted.handleToggleModelDropdownRequest();

        expect(mounted.controller.prepareModelDropdownOpen).not.toHaveBeenCalled();
        expect(popupState.open).not.toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('user closes the model dropdown', () => {
    beforeEach(() => {
        popupState.open.mockReset();
        popupState.close.mockReset();
        popupState.updateData.mockReset();
        popupState.isLiveSession.mockReset();
        popupState.isOpen.value = false;
    });

    it('user sees the dropdown closed and its search cleared', async () => {
        const mounted = await mountCoordinator({
            modelDropdownState: ref({ isOpen: true }),
            modelDropdownQuery: ref('alp'),
        });

        await mounted.closeModelDropdown();

        expect(popupState.close).toHaveBeenCalled();
        expect(mounted.modelDropdownState.value.isOpen).toBe(false);
        expect(mounted.modelDropdownQuery.value).toBe('');

        mounted.unmount();
    });

    it('user still gets the dropdown closed when the popup close throws', async () => {
        popupState.close.mockRejectedValue(new Error('window already gone'));
        const mounted = await mountCoordinator({
            modelDropdownState: ref({ isOpen: true }),
        });

        await expect(mounted.closeModelDropdown()).rejects.toThrow('window already gone');

        // The page state must not stay stuck open just because the window was gone.
        expect(mounted.modelDropdownState.value.isOpen).toBe(false);
        expect(mounted.handleModelDropdownClosed).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the closed signal even when nothing was open', async () => {
        const mounted = await mountCoordinator();

        await mounted.hideAllDropdowns();

        expect(popupState.close).not.toHaveBeenCalled();
        expect(mounted.handleModelDropdownClosed).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets no data refresh while the dropdown is closed', async () => {
        const mounted = await mountCoordinator();

        await mounted.refreshModelDropdownData();

        expect(popupState.updateData).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user sees fresh data when the dropdown is open', async () => {
        const mounted = await mountCoordinator({
            modelDropdownState: ref({ isOpen: true }),
        });

        await mounted.refreshModelDropdownData();

        expect(popupState.updateData).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('user toggles the model dropdown with the shortcut', () => {
    beforeEach(() => {
        popupState.open.mockReset();
        popupState.close.mockReset();
        popupState.isLiveSession.mockReset();
        popupState.isOpen.value = false;
    });

    it('user sees a live dropdown close instead of reopening', async () => {
        popupState.isOpen.value = true;
        popupState.isLiveSession.mockReturnValue(true);
        const mounted = await mountCoordinator({
            modelDropdownState: ref({ isOpen: true }),
        });

        await mounted.handleToggleModelDropdownRequest();

        expect(popupState.close).toHaveBeenCalled();
        expect(mounted.modelDropdownState.value.isOpen).toBe(false);

        mounted.unmount();
    });

    it('user sees a dropdown that lost its window reset before reopening', async () => {
        popupState.isOpen.value = false;
        const mounted = await mountCoordinator({
            modelDropdownState: ref({ isOpen: true }),
        });

        await mounted.handleToggleModelDropdownRequest();

        // The stale open state is cleared first, then a fresh open is requested.
        expect(mounted.handleModelDropdownClosed).toHaveBeenCalled();

        mounted.unmount();
    });
});
