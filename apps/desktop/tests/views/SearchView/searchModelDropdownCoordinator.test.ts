import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useSearchModelDropdownCoordinator } from '@/views/SearchView/composables/useSearchPage';

/**
 * The dropdown data sent to the popup window is the user-visible contract: which
 * models a query matches, in which order, and how a selection is written back to
 * the page draft. The popup itself is a separate window and is stubbed at the
 * module boundary; everything asserted here is what that window would receive.
 */
const { modelDropdownPopupMock, useModelDropdownPopupMock } = vi.hoisted(() => {
    const popup = {
        isOpen: { value: true },
        open: vi.fn(),
        close: vi.fn(),
        updateData: vi.fn(),
        isLiveSession: vi.fn(() => true),
    };

    return {
        modelDropdownPopupMock: popup,
        useModelDropdownPopupMock: vi.fn(() => popup),
    };
});

vi.mock('@/views/SearchView/composables/useModelDropdownPopup', () => ({
    useModelDropdownPopup: useModelDropdownPopupMock,
}));

interface RawModel {
    id: number;
    model_id: string;
    name: string;
    provider_id: number;
    provider_name: string;
    provider_enabled: number;
    reasoning: number;
    tool_call: number;
    modalities: string | null;
    attachment: number;
    open_weights: number;
}

function createModel(overrides: Partial<RawModel> = {}): RawModel {
    return {
        id: 1,
        model_id: 'gpt-5',
        name: 'GPT-5',
        provider_id: 1,
        provider_name: 'OpenAI',
        provider_enabled: 1,
        reasoning: 1,
        tool_call: 1,
        modalities: null,
        attachment: 1,
        open_weights: 0,
        ...overrides,
    };
}

function createController(models: RawModel[]) {
    return {
        getModelDropdownAnchor: vi.fn(() => document.createElement('button')),
        getModelDropdownContext: vi.fn(() => ({
            activeModelId: null,
            activeProviderId: null,
            selectedModelId: null,
            selectedProviderId: null,
            models,
        })),
        prepareModelDropdownOpen: vi.fn().mockResolvedValue(undefined),
        selectModelFromDropdown: vi.fn().mockResolvedValue({ modelId: 'gpt-5', providerId: 1 }),
        closeQuickSearch: vi.fn(),
        isQuickSearchOpen: vi.fn(() => false),
    };
}

interface MountOptions {
    models?: RawModel[];
    query?: string;
    popupOverrides?: Partial<typeof modelDropdownPopupMock>;
    commandHandlers?: Partial<{
        requestModelDropdownOpen: () =>
            | 'noop'
            | 'close-quick-search'
            | 'wait-layout-stable'
            | 'open-model-dropdown';
        handleQuickSearchClosedForModelDropdown: () =>
            | 'noop'
            | 'close-quick-search'
            | 'wait-layout-stable'
            | 'open-model-dropdown';
        handleLayoutStableForModelDropdown: () =>
            | 'noop'
            | 'close-quick-search'
            | 'wait-layout-stable'
            | 'open-model-dropdown';
    }>;
}

async function mountCoordinator(options: MountOptions = {}) {
    const models = options.models ?? [createModel()];
    const controller = createController(models);
    const modelOverride = ref({ modelId: null, providerId: null });
    const modelDropdownState = ref({ isOpen: true });
    const modelDropdownQuery = ref(options.query ?? '');
    const handleModelDropdownOpened = vi.fn();
    const handleModelDropdownClosed = vi.fn();
    const syncOverlayState = vi.fn();
    const openHandlers = options.commandHandlers ?? {};

    Object.assign(modelDropdownPopupMock, options.popupOverrides ?? {});

    const mounted = await mountComposable(() =>
        useSearchModelDropdownCoordinator({
            pageContainer: ref(null),
            controller: controller as never,
            modelOverride,
            modelDropdownState,
            modelDropdownQuery,
            getModelToggleShortcut: () => 'Mod+M',
            requestModelDropdownOpen:
                openHandlers.requestModelDropdownOpen ?? (() => 'noop' as const),
            handleQuickSearchClosedForModelDropdown:
                openHandlers.handleQuickSearchClosedForModelDropdown ?? (() => 'noop' as const),
            handleLayoutStableForModelDropdown:
                openHandlers.handleLayoutStableForModelDropdown ?? (() => 'noop' as const),
            handleModelDropdownOpened,
            handleModelDropdownClosed,
            syncOverlayState,
        })
    );

    const popupCalls = useModelDropdownPopupMock.mock.calls as unknown as Array<[PopupOptions]>;
    const popupOptions = popupCalls[popupCalls.length - 1]![0];

    return {
        ...mounted,
        popupOptions,
        controller,
        modelOverride,
        modelDropdownState,
        modelDropdownQuery,
        handleModelDropdownOpened,
        handleModelDropdownClosed,
        syncOverlayState,
    };
}

interface PopupOptions {
    getPopupData: () => {
        activeModelId: string;
        selectedModelId: string;
        searchQuery: string;
        toggleShortcut: string | null;
        models: Array<{ modelId: string; providerId: number; providerName: string }>;
    };
    isModelDropdownActive: () => boolean;
    onModelSelect: (modelDbId: number) => Promise<void>;
    onModelSearchQueryChange: (query: string) => void;
    onClose: () => void;
}

describe('when the model list searches by name, id or provider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        modelDropdownPopupMock.isOpen.value = true;
        useModelDropdownPopupMock.mockReturnValue(modelDropdownPopupMock);
    });

    const models = [
        createModel({
            id: 1,
            model_id: 'gpt-5',
            name: 'GPT-5',
            provider_id: 1,
            provider_name: 'OpenAI',
        }),
        createModel({
            id: 2,
            model_id: 'claude-sonnet-4',
            name: 'Claude Sonnet 4',
            provider_id: 2,
            provider_name: 'Anthropic',
        }),
        createModel({
            id: 3,
            model_id: 'claude-haiku',
            name: 'Claude Haiku',
            provider_id: 2,
            provider_name: 'Anthropic',
        }),
    ];

    it('user sees every model when the search box is empty', async () => {
        const mounted = await mountCoordinator({ models });

        expect(mounted.popupOptions.getPopupData().models.map((model) => model.modelId)).toEqual([
            'gpt-5',
            'claude-sonnet-4',
            'claude-haiku',
        ]);

        mounted.unmount();
    });

    it('user sees the model whose displayed name matches the query', async () => {
        const mounted = await mountCoordinator({ models, query: 'haiku' });

        expect(mounted.popupOptions.getPopupData().models.map((model) => model.modelId)).toEqual([
            'claude-haiku',
        ]);

        mounted.unmount();
    });

    it('user sees the model whose provider matches the query', async () => {
        const mounted = await mountCoordinator({ models, query: 'anthropic' });

        expect(mounted.popupOptions.getPopupData().models.map((model) => model.modelId)).toEqual([
            'claude-sonnet-4',
            'claude-haiku',
        ]);

        mounted.unmount();
    });

    it('user sees the direct match ahead of the loose match even when it is listed later', async () => {
        const mounted = await mountCoordinator({
            models: [
                createModel({
                    id: 1,
                    model_id: 'great-prompt-thing-4',
                    name: 'Great Prompt Thing 4',
                }),
                createModel({ id: 2, model_id: 'gpt4o-mini', name: 'GPT-4o mini' }),
            ],
            query: 'gpt4',
        });

        // The first model only matches letter by letter; the second contains "gpt4".
        expect(mounted.popupOptions.getPopupData().models.map((model) => model.modelId)).toEqual([
            'gpt4o-mini',
            'great-prompt-thing-4',
        ]);

        mounted.unmount();
    });

    it('user sees the model when the query is a subsequence of its name', async () => {
        const mounted = await mountCoordinator({ models, query: 'gp5' });

        expect(mounted.popupOptions.getPopupData().models.map((model) => model.modelId)).toEqual([
            'gpt-5',
        ]);

        mounted.unmount();
    });

    it('user sees nothing when the query matches no model', async () => {
        const mounted = await mountCoordinator({ models, query: 'gemini' });

        expect(mounted.popupOptions.getPopupData().models).toEqual([]);

        mounted.unmount();
    });

    it('user sees only the models matching every word typed', async () => {
        const mounted = await mountCoordinator({ models, query: 'anthropic sonnet' });

        expect(mounted.popupOptions.getPopupData().models.map((model) => model.modelId)).toEqual([
            'claude-sonnet-4',
        ]);

        mounted.unmount();
    });

    it('user never sees a model from a disabled provider', async () => {
        const mounted = await mountCoordinator({
            models: [createModel({ id: 9, model_id: 'hidden', provider_enabled: 0 })],
        });

        expect(mounted.popupOptions.getPopupData().models).toEqual([]);

        mounted.unmount();
    });

    it('user sees the current query echoed back to the dropdown', async () => {
        const mounted = await mountCoordinator({ models, query: 'sonnet' });

        expect(mounted.popupOptions.getPopupData().searchQuery).toBe('sonnet');

        mounted.unmount();
    });
});

describe('when the user picks a model in the dropdown', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        modelDropdownPopupMock.isOpen.value = true;
        useModelDropdownPopupMock.mockReturnValue(modelDropdownPopupMock);
    });

    it('user gets the picked model written back to the draft and the dropdown closed', async () => {
        const mounted = await mountCoordinator();
        modelDropdownPopupMock.close.mockResolvedValue(undefined);

        await mounted.popupOptions.onModelSelect(1);

        expect(mounted.controller.selectModelFromDropdown).toHaveBeenCalledWith(1);
        expect(mounted.modelOverride.value).toEqual({ modelId: 'gpt-5', providerId: 1 });
        expect(mounted.modelDropdownState.value.isOpen).toBe(false);

        mounted.unmount();
    });

    it('user gets the search text and open state cleared when the dropdown dismisses itself', async () => {
        const mounted = await mountCoordinator({ query: 'gpt' });

        mounted.popupOptions.onModelSearchQueryChange('gpt');

        mounted.popupOptions.onClose();

        expect(mounted.modelDropdownState.value.isOpen).toBe(false);
        expect(mounted.modelDropdownQuery.value).toBe('');
        expect(mounted.handleModelDropdownClosed).toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the page opens the model dropdown', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        modelDropdownPopupMock.isOpen.value = true;
        modelDropdownPopupMock.open.mockResolvedValue(undefined);
        useModelDropdownPopupMock.mockReturnValue(modelDropdownPopupMock);
    });

    it('user gets the dropdown opened once the layout is stable', async () => {
        const mounted = await mountCoordinator({
            commandHandlers: { requestModelDropdownOpen: () => 'open-model-dropdown' },
        });

        await mounted.result.openModelDropdownWithLayoutSync();

        expect(mounted.controller.prepareModelDropdownOpen).toHaveBeenCalled();
        expect(modelDropdownPopupMock.open).toHaveBeenCalled();
        expect(mounted.modelDropdownState.value.isOpen).toBe(true);
        expect(mounted.handleModelDropdownOpened).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the quick search closed first when it was covering the dropdown', async () => {
        const mounted = await mountCoordinator({
            commandHandlers: {
                requestModelDropdownOpen: () => 'close-quick-search',
                handleQuickSearchClosedForModelDropdown: () => 'open-model-dropdown',
            },
        });

        await mounted.result.openModelDropdownWithLayoutSync();

        expect(mounted.controller.closeQuickSearch).toHaveBeenCalled();
        expect(modelDropdownPopupMock.open).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets nothing opened when the request is a noop', async () => {
        const mounted = await mountCoordinator();

        await mounted.result.openModelDropdownWithLayoutSync();

        expect(modelDropdownPopupMock.open).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user sees the dropdown stay closed and the search text cleared when opening fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        modelDropdownPopupMock.open.mockRejectedValue(new Error('popup window failed'));
        const mounted = await mountCoordinator({
            query: 'typed',
            commandHandlers: { requestModelDropdownOpen: () => 'open-model-dropdown' },
        });

        await mounted.result.openModelDropdownWithLayoutSync();

        expect(mounted.modelDropdownState.value.isOpen).toBe(false);
        expect(mounted.modelDropdownQuery.value).toBe('');
        expect(mounted.syncOverlayState).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the dropdown closed off the popup window rather than the local state', async () => {
        const mounted = await mountCoordinator({
            commandHandlers: { requestModelDropdownOpen: () => 'open-model-dropdown' },
        });
        modelDropdownPopupMock.close.mockResolvedValue(undefined);

        await mounted.result.closeModelDropdown();

        expect(modelDropdownPopupMock.close).toHaveBeenCalled();
        expect(mounted.modelDropdownState.value.isOpen).toBe(false);
        expect(mounted.modelDropdownQuery.value).toBe('');

        mounted.unmount();
    });

    it('user gets the dropdown closed even when the popup refuses to close', async () => {
        const mounted = await mountCoordinator();
        modelDropdownPopupMock.close.mockRejectedValue(new Error('window already gone'));

        await expect(mounted.result.closeModelDropdown()).rejects.toThrow('window already gone');

        // The local state must not be left thinking a dead window is open.
        expect(mounted.modelDropdownState.value.isOpen).toBe(false);

        mounted.unmount();
    });

    it('user gets the dropdown data refreshed only when it is open', async () => {
        const mounted = await mountCoordinator();
        modelDropdownPopupMock.updateData.mockResolvedValue(undefined);

        await mounted.result.refreshModelDropdownData();
        expect(modelDropdownPopupMock.updateData).toHaveBeenCalled();

        mounted.modelDropdownState.value = { isOpen: false };
        await mounted.result.refreshModelDropdownData();

        expect(modelDropdownPopupMock.updateData).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('user gets the dropdown toggled closed when the shortcut is pressed while it is open', async () => {
        const mounted = await mountCoordinator();
        modelDropdownPopupMock.isOpen.value = true;
        modelDropdownPopupMock.isLiveSession.mockReturnValue(true);
        modelDropdownPopupMock.close.mockResolvedValue(undefined);

        await mounted.result.handleToggleModelDropdownRequest();

        expect(modelDropdownPopupMock.close).toHaveBeenCalled();
        expect(mounted.modelDropdownState.value.isOpen).toBe(false);

        mounted.unmount();
    });

    it('user gets a stale dropdown closed and the dropdown hidden when its window is gone', async () => {
        const mounted = await mountCoordinator();
        modelDropdownPopupMock.isOpen.value = false;

        await mounted.result.handleToggleModelDropdownRequest();

        expect(mounted.handleModelDropdownClosed).toHaveBeenCalled();
        expect(mounted.modelDropdownState.value.isOpen).toBe(false);

        mounted.unmount();
    });

    it('user gets the dropdown data updated when its open state changes', async () => {
        const mounted = await mountCoordinator();
        modelDropdownPopupMock.updateData.mockResolvedValue(undefined);
        modelDropdownPopupMock.updateData.mockClear();

        mounted.modelDropdownState.value = { isOpen: false };
        await Promise.resolve();
        mounted.modelDropdownState.value = { isOpen: true };
        await Promise.resolve();
        await Promise.resolve();

        expect(modelDropdownPopupMock.updateData).toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the dropdown hidden through the blanket hide call', async () => {
        const mounted = await mountCoordinator();
        modelDropdownPopupMock.close.mockResolvedValue(undefined);

        await mounted.result.hideAllDropdowns();

        expect(mounted.modelDropdownState.value.isOpen).toBe(false);

        mounted.unmount();
    });

    it('user gets the close handler fired even when no dropdown was open', async () => {
        const mounted = await mountCoordinator();
        mounted.modelDropdownState.value = { isOpen: false };

        await mounted.result.hideAllDropdowns();

        expect(mounted.handleModelDropdownClosed).toHaveBeenCalled();
        expect(modelDropdownPopupMock.close).not.toHaveBeenCalled();

        mounted.unmount();
    });
});
