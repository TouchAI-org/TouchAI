import { mountComposable as mountBaseComposable } from '@tests/utils/composables';
import { createStartupNoticeFixture } from '@tests/utils/startupNotices';
import { mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { createSearchInteractionContext } from '@/views/SearchView/composables/searchInteraction';
import { useSearchPageLifecycle } from '@/views/SearchView/composables/useSearchPage';

/**
 * The e2e build must not touch the host shortcut registry or ask for the
 * notification permission: the e2e harness owns both. The runtime-mode helper
 * memoises its probe for the lifetime of the module, so this case needs its own
 * module instance instead of a shared setup — hence a separate file.
 */
const { currentWindowMock, initNotificationPermissionMock, nativeMock } = vi.hoisted(() => ({
    currentWindowMock: {
        label: 'main',
        isVisible: vi.fn(),
        isAlwaysOnTop: vi.fn(),
        setAlwaysOnTop: vi.fn(),
    },
    initNotificationPermissionMock: vi.fn(),
    nativeMock: {
        runtime: { getRuntimeInfo: vi.fn() },
        shortcut: {
            registerGlobalShortcut: vi.fn(),
            setSearchSurfaceShortcuts: vi.fn(),
        },
        window: {
            hideSearchWindow: vi.fn(),
            setSearchSurfaceHideOnAppBlur: vi.fn(),
        },
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => currentWindowMock,
}));
vi.mock('@/app/api/windows/notifications', () => ({
    initNotificationPermission: initNotificationPermissionMock,
    notify: vi.fn(),
}));
vi.mock('@composables/useAlert', () => ({ useAlert: vi.fn() }));
vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        globalShortcut: 'Alt+Space',
    }),
}));

let startupFixture: ReturnType<typeof createStartupNoticeFixture>;
const mountComposable: typeof mountBaseComposable = (factory, configure) =>
    mountBaseComposable(factory, (app) => {
        startupFixture.provide(app);
        configure?.(app);
    });
beforeEach(() => {
    startupFixture = createStartupNoticeFixture();
});

async function flushLifecycle() {
    for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
        await nextTick();
    }
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    currentWindowMock.isVisible.mockResolvedValue(true);
    currentWindowMock.isAlwaysOnTop.mockResolvedValue(false);
    currentWindowMock.setAlwaysOnTop.mockResolvedValue(undefined);
    nativeMock.runtime.getRuntimeInfo.mockResolvedValue({ isE2eTestMode: true });
    nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
    nativeMock.shortcut.setSearchSurfaceShortcuts.mockResolvedValue(undefined);
    nativeMock.window.hideSearchWindow.mockResolvedValue(undefined);
    nativeMock.window.setSearchSurfaceHideOnAppBlur.mockResolvedValue(undefined);
    initNotificationPermissionMock.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('when the app runs under the e2e harness', () => {
    it('user gets no global shortcut registered so the harness keeps owning the hotkey', async () => {
        await mountComposable(() =>
            useSearchPageLifecycle({
                controller: {
                    focusConversation: vi.fn(),
                    focusSearchInput: vi.fn().mockResolvedValue(undefined),
                    loadActiveModel: vi.fn().mockResolvedValue(undefined),
                    invalidateModelDropdownData: vi.fn(),
                    isQuickSearchOpen: vi.fn(() => false),
                    isQuickSearchItemHighlighted: vi.fn(() => false),
                    isQuickSearchContextMenuOpen: vi.fn(() => false),
                } as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext: createSearchInteractionContext(),
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );
        await flushLifecycle();

        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
    });

    it('user gets no notification permission prompt from the automated run', async () => {
        await mountComposable(() =>
            useSearchPageLifecycle({
                controller: {
                    focusConversation: vi.fn(),
                    focusSearchInput: vi.fn().mockResolvedValue(undefined),
                    loadActiveModel: vi.fn().mockResolvedValue(undefined),
                    invalidateModelDropdownData: vi.fn(),
                    isQuickSearchOpen: vi.fn(() => false),
                    isQuickSearchItemHighlighted: vi.fn(() => false),
                    isQuickSearchContextMenuOpen: vi.fn(() => false),
                } as never,
                viewReady: ref(true),
                isDragging: ref(false),
                isPinned: ref(false),
                interactionContext: createSearchInteractionContext(),
                syncWindowPinState: vi.fn().mockResolvedValue(false),
                clearSession: vi.fn(),
            })
        );
        await flushLifecycle();

        // The e2e browser profile must not be blocked by an OS permission dialog.
        expect(initNotificationPermissionMock).not.toHaveBeenCalled();
    });
});

beforeEach(() => {
    mockTauriCommand('get_runtime_info', () => nativeMock.runtime.getRuntimeInfo());
    mockTauriCommand('register_global_shortcut', (payload) =>
        nativeMock.shortcut.registerGlobalShortcut((payload as { shortcut: string }).shortcut)
    );
    mockTauriCommand('hide_search_window', (payload) => {
        if ((payload as { ifUnfocused?: boolean } | undefined)?.ifUnfocused) return undefined;
        return nativeMock.window.hideSearchWindow();
    });
    mockTauriCommand('set_search_surface_hide_on_app_blur', (payload) =>
        nativeMock.window.setSearchSurfaceHideOnAppBlur(
            (payload as { shouldHide: boolean }).shouldHide
        )
    );
    mockTauriCommand('set_search_surface_shortcuts', (payload) =>
        nativeMock.shortcut.setSearchSurfaceShortcuts((payload as { entries: unknown }).entries)
    );
});
