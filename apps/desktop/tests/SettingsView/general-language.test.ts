import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale, tt } from '@/i18n';
import GeneralSection from '@/views/SettingsView/components/General/index.vue';
import { resolveShortcutCaptureCompletion } from '@/views/SettingsView/components/General/shortcutCapture';

const resolveSettingKey = (input: unknown, fallback?: string) => {
    if (typeof input === 'object' && input !== null && 'key' in input) {
        return String((input as { key: unknown }).key);
    }
    return fallback ?? '';
};

const { getSettingValueMock } = vi.hoisted(() => ({
    getSettingValueMock: vi.fn(async (input: unknown, key?: string) =>
        resolveSettingKey(input, key) === 'language' ? 'en-US' : null
    ),
}));

vi.mock('@database/queries', () => ({
    getSettingValue: getSettingValueMock,
    setSetting: vi.fn(async () => undefined),
}));

vi.mock('@services/EventService', () => ({
    AppEvent: { SETTINGS_GENERAL_UPDATED: 'settings-general-updated' },
    eventService: {
        emit: vi.fn(async () => undefined),
        on: vi.fn(async () => undefined),
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        label: 'settings',
    }),
}));

vi.mock('@services/NativeService', () => ({
    native: {
        autostart: {
            disableAutostart: vi.fn(async () => undefined),
            enableAutostart: vi.fn(async () => undefined),
            isAutostartEnabled: vi.fn(async () => false),
        },
        shortcut: {
            getShortcutStatus: vi.fn(async () => [false, null]),
            registerGlobalShortcut: vi.fn(async () => undefined),
        },
        window: {
            setSearchWindowDefaults: vi.fn(async () => undefined),
        },
    },
}));

vi.mock('@services/NotificationService', () => ({
    notify: vi.fn(),
}));

vi.mock('@components/AlertMessage.vue', () => ({
    default: {
        name: 'AlertMessage',
        template: '<div data-testid="alert-message" />',
        methods: {
            error: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
        },
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options'],
        emits: ['update:modelValue'],
        template:
            '<div data-testid="custom-select"><div v-for="option in options" :key="option.value">{{ option.label }} {{ option.description }}</div></div>',
    },
}));

async function flushMountedPromises() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
    }
}

describe('Settings General shortcut capture i18n', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        getSettingValueMock.mockImplementation(async (input: unknown, key?: string) =>
            resolveSettingKey(input, key) === 'language' ? 'en-US' : null
        );
        setLocale('zh-CN');
    });

    it('localizes the shortcut capture prompt from source text', () => {
        setLocale('en-US');

        expect(tt('请按下快捷键...')).toBe('Press a shortcut...');
    });

    it('restores the current shortcut when the localized prompt is blurred without a captured key', () => {
        setLocale('en-US');

        expect(
            resolveShortcutCaptureCompletion({
                currentShortcut: 'Alt+Space',
                displayShortcut: tt('请按下快捷键...'),
                hasCapturedShortcut: false,
            })
        ).toEqual({
            action: 'restore',
            displayShortcut: 'Alt+Space',
        });
    });

    it('does not save when the captured shortcut matches the current shortcut', () => {
        expect(
            resolveShortcutCaptureCompletion({
                currentShortcut: 'Alt+Space',
                displayShortcut: 'Alt+Space',
                hasCapturedShortcut: true,
            })
        ).toEqual({
            action: 'skip',
            displayShortcut: 'Alt+Space',
        });
    });

    it('requests saving only after a real shortcut was captured', () => {
        expect(
            resolveShortcutCaptureCompletion({
                currentShortcut: 'Alt+Space',
                displayShortcut: 'Ctrl+Space',
                hasCapturedShortcut: true,
            })
        ).toEqual({
            action: 'save',
            displayShortcut: 'Ctrl+Space',
            shortcut: 'Ctrl+Space',
        });
    });

    it('renders general settings copy and option labels in English without DOM localization', async () => {
        setLocale('en-US');

        const wrapper = mount(GeneralSection, {
            global: {
                plugins: [createPinia()],
            },
        });

        await flushMountedPromises();

        expect(wrapper.text()).toContain('General settings');
        expect(wrapper.text()).toContain('Configure basic app behavior and appearance');
        expect(wrapper.text()).toContain('Global shortcut');
        expect(wrapper.text()).toContain('Startup settings');
        expect(wrapper.text()).toContain('Run TouchAI automatically when the system starts');
        expect(wrapper.text()).toContain('Conversation settings');
        expect(wrapper.text()).toContain('Follow output');
        expect(wrapper.text()).toContain('Automatically scroll to the latest content');
        expect(wrapper.text()).toContain('Search window');
        expect(wrapper.text()).toContain('Default size');
        expect(wrapper.text()).toContain('Language');
        expect(wrapper.text()).toContain('Interface language');
        expect(wrapper.text()).not.toContain('常规设置');
        expect(wrapper.text()).not.toContain('输出时滚动策略');
    });
});
