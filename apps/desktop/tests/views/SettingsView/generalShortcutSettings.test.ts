import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import GeneralShortcutSettings from '@/views/SettingsView/components/General/GeneralShortcutSettings.vue';

/*
 * The activation shortcut is the one setting a user changes by pressing keys
 * rather than by typing. What matters is what the field shows afterwards and
 * whether the app actually accepted the new key combination, so every test
 * below asserts the visible value or the alert the user gets, not the internal
 * capture state.
 */

// A real ref, so changing the setting elsewhere reaches the component's watcher.
const settingsMock = await vi.hoisted(async () => {
    const { ref } = await import('vue');
    return {
        settings: ref({
            globalShortcut: 'Alt+Space',
            searchKeybindings: {
                'search.history.open': 'Mod+H',
            } as Record<string, string | null>,
        }),
        initialize: vi.fn(),
        updateGlobalShortcut: vi.fn(),
    };
});

const nativeMock = vi.hoisted(() => ({
    shortcut: {
        getShortcutStatus: vi.fn(),
        registerGlobalShortcut: vi.fn(),
    },
}));

const alertMock = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
}));

const notifyMock = vi.hoisted(() => vi.fn());

const eventServiceMock = vi.hoisted(() => ({
    on: vi.fn(),
}));

vi.mock('pinia', () => ({
    storeToRefs: () => ({ settings: settingsMock.settings }),
}));

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => settingsMock,
}));

vi.mock('@services/NativeService', () => ({ native: nativeMock }));

vi.mock('@services/NotificationService', () => ({ notify: notifyMock }));

vi.mock('@services/EventService', () => ({
    AppEvent: { SHORTCUT_CAPTURE_SYSTEM_KEY: 'shortcut:capture-system-key' },
    eventService: eventServiceMock,
}));

vi.mock('@components/AlertMessage.vue', () => ({
    default: {
        name: 'AlertMessageStub',
        template: '<div data-testid="alert-message" />',
        methods: {
            success: alertMock.success,
            error: alertMock.error,
            warning: alertMock.warning,
        },
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

/*
 * The real select renders its trigger through a portal and opens on focus;
 * the capture behaviour under test only needs the trigger slot and the two
 * events, so the stub forwards those and renders the options inline.
 */
vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelectStub',
        props: ['modelValue', 'options', 'open', 'disabled', 'displayLabel'],
        emits: ['update:modelValue', 'update:open'],
        template: `
            <div data-testid="custom-select">
                <slot name="trigger" />
                <div v-if="open" data-testid="preset-menu">
                    <button
                        v-for="option in options"
                        :key="option.value"
                        type="button"
                        :data-testid="'preset-' + option.value"
                        @click="$emit('update:modelValue', option.value)"
                    >
                        {{ option.label }}
                    </button>
                    <button
                        type="button"
                        data-testid="preset-close"
                        @click="$emit('update:open', false)"
                    >
                        close
                    </button>
                </div>
            </div>
        `,
    },
}));

enableAutoUnmount(afterEach);

function shortcutField(wrapper: ReturnType<typeof mount>) {
    return wrapper.get('[data-testid="settings-global-shortcut-input"]');
}

function fieldValue(wrapper: ReturnType<typeof mount>): string {
    return (shortcutField(wrapper).element as HTMLInputElement).value;
}

async function mountSection() {
    const wrapper = mount(GeneralShortcutSettings, { attachTo: document.body });
    await flushPromises();
    return wrapper;
}

/** Focus the field, which is how a user starts recording a new shortcut. */
async function startCapture(wrapper: ReturnType<typeof mount>) {
    await shortcutField(wrapper).trigger('focus');
    await flushPromises();
}

async function pressKeys(init: KeyboardEventInit) {
    window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    );
    await flushPromises();
}

beforeEach(() => {
    vi.clearAllMocks();
    setLocale('zh-CN');
    settingsMock.settings.value.globalShortcut = 'Alt+Space';
    settingsMock.settings.value.searchKeybindings = { 'search.history.open': 'Mod+H' };
    settingsMock.initialize.mockResolvedValue(undefined);
    settingsMock.updateGlobalShortcut.mockImplementation(async (shortcut: string) => {
        settingsMock.settings.value.globalShortcut = shortcut;
    });
    nativeMock.shortcut.getShortcutStatus.mockResolvedValue([false, null]);
    nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
    eventServiceMock.on.mockResolvedValue(() => undefined);
    Object.defineProperty(window.navigator, 'platform', {
        configurable: true,
        value: 'Win32',
    });
});

describe('user sees the activation shortcut they already use', () => {
    it('user sees the saved shortcut in the field once settings load', async () => {
        const wrapper = await mountSection();

        expect(fieldValue(wrapper)).toBe('Alt+Space');
    });

    it('user sees the field follow a shortcut changed elsewhere', async () => {
        const wrapper = await mountSection();

        settingsMock.settings.value.globalShortcut = 'Ctrl+Space';
        await wrapper.vm.$nextTick();

        expect(fieldValue(wrapper)).toBe('Ctrl+Space');
    });

    it('user sees an occupied marker when the shortcut was not registered at startup', async () => {
        nativeMock.shortcut.getShortcutStatus.mockResolvedValue([true, 'already registered']);

        const wrapper = await mountSection();

        expect(wrapper.find('[data-testid="settings-shortcut-occupied-indicator"]').exists()).toBe(
            true
        );
    });

    it('user sees no occupied marker when the shortcut is registered fine', async () => {
        const wrapper = await mountSection();

        expect(wrapper.find('[data-testid="settings-shortcut-occupied-indicator"]').exists()).toBe(
            false
        );
    });
});

describe('user records a new activation shortcut', () => {
    it('user is asked to press keys once the field takes focus', async () => {
        const wrapper = await mountSection();

        await startCapture(wrapper);

        expect(fieldValue(wrapper)).toBe('请按下快捷键...');
        expect(wrapper.find('[data-testid="preset-menu"]').exists()).toBe(true);
    });

    it('user gets the pressed combination saved and shown', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await pressKeys({ key: 'n', ctrlKey: true });

        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith('Ctrl+N');
        expect(settingsMock.settings.value.globalShortcut).toBe('Ctrl+N');
        expect(fieldValue(wrapper)).toBe('Ctrl+N');
    });

    it('user gets a rejected combination kept out of the settings', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        // A bare key would fight with typing in the search window.
        await pressKeys({ key: 'a' });

        expect(settingsMock.updateGlobalShortcut).not.toHaveBeenCalled();
        expect(fieldValue(wrapper)).toBe('请按下快捷键...');
    });

    it('user is told why a bare key cannot be the activation shortcut', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await pressKeys({ key: 'a' });

        expect(alertMock.warning).toHaveBeenCalledTimes(1);
        expect(fieldValue(wrapper)).not.toBe('A');
    });

    it('user keeps the current shortcut when the new one is already a search shortcut', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await pressKeys({ key: 'h', ctrlKey: true });

        expect(settingsMock.updateGlobalShortcut).not.toHaveBeenCalled();
        expect(fieldValue(wrapper)).toBe('Alt+Space');
        expect(alertMock.error).toHaveBeenCalledTimes(1);
    });

    it('user is told the shortcut was saved', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await pressKeys({ key: 'n', ctrlKey: true });

        expect(alertMock.success).toHaveBeenCalledTimes(1);
    });

    it('user keeps the old shortcut when the system refuses to register the new one', async () => {
        nativeMock.shortcut.registerGlobalShortcut.mockRejectedValue(
            new Error('shortcut already registered')
        );
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await pressKeys({ key: 'n', ctrlKey: true });

        expect(settingsMock.updateGlobalShortcut).not.toHaveBeenCalled();
        expect(settingsMock.settings.value.globalShortcut).toBe('Alt+Space');
        expect(wrapper.find('[data-testid="settings-shortcut-occupied-indicator"]').exists()).toBe(
            true
        );
        expect(notifyMock).toHaveBeenCalled();
        expect(alertMock.error).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it('user is not asked to save a shortcut they already have', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await pressKeys({ key: ' ', code: 'Space', altKey: true });

        expect(settingsMock.updateGlobalShortcut).not.toHaveBeenCalled();
        expect(fieldValue(wrapper)).toBe('Alt+Space');
    });

    it('user gets the saved shortcut back when the recorder is dismissed', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        // Closing the suggestion menu is how the recorder is dismissed.
        await wrapper.get('[data-testid="preset-close"]').trigger('click');
        await flushPromises();

        expect(settingsMock.updateGlobalShortcut).not.toHaveBeenCalled();
        expect(fieldValue(wrapper)).toBe('Alt+Space');
    });
});

describe('user picks a suggested activation shortcut', () => {
    it('user sees the offered presets while recording', async () => {
        const wrapper = await mountSection();

        await startCapture(wrapper);

        expect(wrapper.get('[data-testid="preset-Alt+Space"]').text()).toBe('Alt+Space');
        expect(wrapper.get('[data-testid="preset-Ctrl+Space"]').text()).toBe('Ctrl+Space');
    });

    it('user gets the preset applied and the menu closed', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await wrapper.get('[data-testid="preset-Ctrl+Space"]').trigger('click');
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith('Ctrl+Space');
        expect(settingsMock.settings.value.globalShortcut).toBe('Ctrl+Space');
        expect(fieldValue(wrapper)).toBe('Ctrl+Space');
        expect(wrapper.find('[data-testid="preset-menu"]').exists()).toBe(false);
    });
});

describe('user records a shortcut the system reports separately', () => {
    it('user gets a system-reported combination saved while recording', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);
        const handler = eventServiceMock.on.mock.calls[0]?.[1] as (payload: unknown) => void;

        handler({ key: 'Space', alt: true, ctrl: false, shift: false });
        await flushPromises();

        expect(settingsMock.settings.value.globalShortcut).toBe('Alt+Space');
    });
});
