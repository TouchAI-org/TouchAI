import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import GeneralShortcutSettings from '@/views/SettingsView/components/General/GeneralShortcutSettings.vue';

/*
 * The generalShortcutSettings test covers recording, saving and the conflict
 * paths. This file covers what the field does when it is *not* being recorded:
 * the busy state while a save is in flight, the preset menu's open/close guard,
 * the reserved keys that must be left to the page, and the notification text the
 * user reads when the OS rejects a combination for each of its known reasons.
 */

const settingsMock = await vi.hoisted(async () => {
    const { ref } = await import('vue');
    return {
        settings: ref({
            globalShortcut: 'Alt+Space',
            searchKeybindings: {} as Record<string, string | null>,
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
const eventServiceMock = vi.hoisted(() => ({ on: vi.fn() }));

vi.mock('pinia', () => ({
    storeToRefs: () => ({ settings: settingsMock.settings }),
}));

vi.mock('@/stores/settings', () => ({ useSettingsStore: () => settingsMock }));

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

// The trigger slot plus the two events is all the capture behaviour needs.
vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelectStub',
        props: ['modelValue', 'options', 'open', 'disabled', 'displayLabel'],
        emits: ['update:modelValue', 'update:open'],
        template: `
            <div data-testid="custom-select" :data-disabled="String(disabled)">
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
                </div>
            </div>
        `,
    },
}));

enableAutoUnmount(afterEach);

function field(wrapper: ReturnType<typeof mount>) {
    return wrapper.get('[data-testid="settings-global-shortcut-input"]');
}

function value(wrapper: ReturnType<typeof mount>): string {
    return (field(wrapper).element as HTMLInputElement).value;
}

async function mountSection() {
    const wrapper = mount(GeneralShortcutSettings, { attachTo: document.body });
    await flushPromises();
    return wrapper;
}

async function startCapture(wrapper: ReturnType<typeof mount>) {
    await field(wrapper).trigger('focus');
    await flushPromises();
}

async function pressKeys(init: KeyboardEventInit) {
    window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    );
    await flushPromises();
}

/** The system-key event the app forwards when the OS swallows a combination. */
function systemKey(payload: Record<string, unknown>) {
    const handler = eventServiceMock.on.mock.calls[0]?.[1] as
        | ((payload: unknown) => void)
        | undefined;
    handler?.(payload);
}

beforeEach(() => {
    vi.clearAllMocks();
    setLocale('zh-CN');
    settingsMock.settings.value.globalShortcut = 'Alt+Space';
    settingsMock.settings.value.searchKeybindings = {};
    settingsMock.initialize.mockResolvedValue(undefined);
    settingsMock.updateGlobalShortcut.mockImplementation(async (shortcut: string) => {
        settingsMock.settings.value.globalShortcut = shortcut;
    });
    nativeMock.shortcut.getShortcutStatus.mockResolvedValue([false, null]);
    nativeMock.shortcut.registerGlobalShortcut.mockResolvedValue(undefined);
    eventServiceMock.on.mockResolvedValue(() => undefined);
    Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'Win32' });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('user reads the notification when the OS rejects a shortcut', () => {
    async function rejectionBody(error: string): Promise<string> {
        nativeMock.shortcut.registerGlobalShortcut.mockRejectedValue(new Error(error));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const wrapper = await mountSection();
        await startCapture(wrapper);
        await pressKeys({ key: 'n', ctrlKey: true });

        const body = (notifyMock.mock.calls[0]?.[0]?.body ?? '') as string;
        consoleError.mockRestore();
        wrapper.unmount();
        return body;
    }

    it('user is told the shortcut is taken when the OS says it is registered', async () => {
        expect(await rejectionBody('already registered')).toContain('Ctrl+N');
    });

    it('user is told the shortcut is taken when the OS answers in Chinese', async () => {
        expect(await rejectionBody('已注册')).toContain('Ctrl+N');
    });

    it('user is told the format is invalid when the OS rejects it', async () => {
        const body = await rejectionBody('invalid shortcut format');

        expect(body.length).toBeGreaterThan(0);
    });

    it('user is told the format is invalid when the OS answers in Chinese', async () => {
        const body = await rejectionBody('无效的快捷键');

        expect(body.length).toBeGreaterThan(0);
    });

    it('user is told the key is unsupported when the OS does not know it', async () => {
        const body = await rejectionBody('Unknown key F13');

        expect(body.length).toBeGreaterThan(0);
    });

    it('user gets the raw reason echoed when the failure has no known cause', async () => {
        const body = await rejectionBody('something else entirely');

        expect(body).toContain('something else entirely');
    });
});

describe('user is told when settings could not be loaded', () => {
    it('user gets an error alert when the settings store fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        settingsMock.initialize.mockRejectedValue(new Error('database locked'));

        const wrapper = await mountSection();

        expect(alertMock.error).toHaveBeenCalled();
        // Nothing was read, so the field is left empty rather than showing a stale
        // value — and it must not be stuck in recording mode either.
        expect(value(wrapper)).toBe('');
        expect(value(wrapper)).not.toBe('请按下快捷键...');
        consoleError.mockRestore();
    });

    it('user still gets a usable field when the shortcut status cannot be read', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        nativeMock.shortcut.getShortcutStatus.mockRejectedValue(new Error('no native bridge'));

        const wrapper = await mountSection();

        expect(value(wrapper)).toBe('Alt+Space');
        consoleError.mockRestore();
    });
});

describe('user keeps the field out of the way while a save is in flight', () => {
    it('user gets the field locked and the presets disabled while saving', async () => {
        let release: (() => void) | undefined;
        nativeMock.shortcut.registerGlobalShortcut.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                })
        );
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await pressKeys({ key: 'n', ctrlKey: true });

        expect(field(wrapper).attributes('disabled')).toBeDefined();
        expect(wrapper.get('[data-testid="custom-select"]').attributes('data-disabled')).toBe(
            'true'
        );

        release?.();
        await flushPromises();
    });

    it('user gets the preset menu ignored while saving', async () => {
        let release: (() => void) | undefined;
        nativeMock.shortcut.registerGlobalShortcut.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                })
        );
        const wrapper = await mountSection();
        await startCapture(wrapper);
        await pressKeys({ key: 'n', ctrlKey: true });

        wrapper.findComponent({ name: 'CustomSelectStub' }).vm.$emit('update:open', true);
        await wrapper.vm.$nextTick();

        // Recording must not restart in the middle of a save.
        expect(value(wrapper)).not.toBe('请按下快捷键...');

        release?.();
        await flushPromises();
    });
});

describe('user keeps the field honest when the shortcut is not registered', () => {
    it('user does not see the field pretend a broken shortcut changed', async () => {
        nativeMock.shortcut.getShortcutStatus.mockResolvedValue([true, 'already registered']);
        const wrapper = await mountSection();
        const before = value(wrapper);

        // Another window changed the setting while the OS still holds the old one.
        settingsMock.settings.value.globalShortcut = 'Ctrl+Space';
        await wrapper.vm.$nextTick();

        // The field keeps showing the shortcut the user actually has registered.
        expect(value(wrapper)).toBe(before);
        expect(wrapper.find('[data-testid="settings-shortcut-occupied-indicator"]').exists()).toBe(
            true
        );
    });
});

describe('user picks a preset while still recording', () => {
    it('user gets the preset saved and the recording stopped', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);
        expect(value(wrapper)).toBe('请按下快捷键...');

        await wrapper.get('[data-testid="preset-Alt+Space"]').trigger('click');
        await flushPromises();

        expect(value(wrapper)).not.toBe('请按下快捷键...');
        expect(wrapper.find('[data-testid="preset-menu"]').exists()).toBe(false);
    });
});

describe('user opens and closes the preset menu with the mouse', () => {
    it('user gets recording started when the menu opens', async () => {
        const wrapper = await mountSection();
        expect(value(wrapper)).toBe('Alt+Space');

        wrapper.findComponent({ name: 'CustomSelectStub' }).vm.$emit('update:open', true);
        await flushPromises();

        expect(value(wrapper)).toBe('请按下快捷键...');
        expect(wrapper.find('[data-testid="preset-menu"]').exists()).toBe(true);
    });

    it('user gets the menu close ignored when it was never opened', async () => {
        const wrapper = await mountSection();

        // The select reports a close on its own teardown even when nothing was open.
        wrapper.findComponent({ name: 'CustomSelectStub' }).vm.$emit('update:open', false);
        await flushPromises();

        expect(value(wrapper)).toBe('Alt+Space');
    });

    it('user gets the recording stopped when they close the menu', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);
        expect(value(wrapper)).toBe('请按下快捷键...');

        wrapper.findComponent({ name: 'CustomSelectStub' }).vm.$emit('update:open', false);
        await flushPromises();

        expect(value(wrapper)).toBe('Alt+Space');
        expect(wrapper.find('[data-testid="preset-menu"]').exists()).toBe(false);
    });
});

describe('user leaves keys the page needs to the page', () => {
    it('user gets the recording kept when they press Tab to move on', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        const event = new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        });
        window.dispatchEvent(event);
        await flushPromises();

        expect(event.defaultPrevented).toBe(false);
        expect(value(wrapper)).toBe('请按下快捷键...');
    });

    it('user gets a keystroke ignored when the field is not recording', async () => {
        const wrapper = await mountSection();

        await pressKeys({ key: 'n', ctrlKey: true });

        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
        expect(value(wrapper)).toBe('Alt+Space');
    });
});

describe('user is told the Windows key cannot be used', () => {
    it('user gets a warning instead of a saved shortcut on Windows', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await pressKeys({ key: 'n', metaKey: true });

        expect(alertMock.warning).toHaveBeenCalled();
        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
    });

    it('user on a Mac gets no Windows-key warning because Command is a real modifier', async () => {
        Object.defineProperty(window.navigator, 'platform', {
            configurable: true,
            value: 'MacIntel',
        });
        const wrapper = await mountSection();
        await startCapture(wrapper);

        await pressKeys({ key: 'n', metaKey: true });

        expect(alertMock.warning).not.toHaveBeenCalled();
        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith('Cmd+N');
    });
});

describe('user gets a system-reported key applied', () => {
    it('user gets the combination from the OS saved while recording', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        systemKey({ key: 'K', ctrl: true });
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith('Ctrl+K');
    });

    it('user gets a system key without a modifier ignored', async () => {
        const wrapper = await mountSection();
        await startCapture(wrapper);

        systemKey({ key: 'K', ctrl: false, alt: false, shift: false });
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
        expect(value(wrapper)).toBe('请按下快捷键...');
    });

    it('user gets a system key ignored when the field is not recording', async () => {
        await mountSection();

        systemKey({ key: 'K', ctrl: true });
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
    });
});

describe('user leaves the settings page', () => {
    it('user gets the system-key listener released on unmount', async () => {
        const unsubscribe = vi.fn();
        eventServiceMock.on.mockResolvedValue(unsubscribe);
        const wrapper = await mountSection();

        wrapper.unmount();

        expect(unsubscribe).toHaveBeenCalled();
    });
});
