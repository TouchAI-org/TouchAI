import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import GeneralSection from '@/views/SettingsView/components/General/index.vue';

const settingsStoreMock = vi.hoisted(() => ({
    settings: {
        value: {
            globalShortcut: 'Alt+Space',
            startOnBoot: false,
            startMinimized: true,
            outputScrollBehavior: 'follow_output',
            searchWindowSizePreset: 'normal',
            searchWindowDefaultSize: { width: 720, height: 520 },
        },
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    updateGlobalShortcut: vi.fn().mockResolvedValue(undefined),
    updateStartOnBoot: vi.fn().mockResolvedValue(undefined),
    updateStartMinimized: vi.fn().mockResolvedValue(undefined),
    updateOutputScrollBehavior: vi.fn().mockResolvedValue(undefined),
    updateSearchWindowSizePreset: vi.fn().mockResolvedValue(undefined),
}));

const nativeMock = vi.hoisted(() => ({
    shortcut: {
        getShortcutStatus: vi.fn().mockResolvedValue([false, null]),
        registerGlobalShortcut: vi.fn().mockResolvedValue(undefined),
    },
    autostart: {
        isAutostartEnabled: vi.fn().mockResolvedValue(false),
        enableAutostart: vi.fn().mockResolvedValue(undefined),
        disableAutostart: vi.fn().mockResolvedValue(undefined),
    },
    window: {
        setSearchWindowDefaults: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('pinia', () => ({
    storeToRefs: (store: typeof settingsStoreMock) => ({
        settings: store.settings,
    }),
}));

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => settingsStoreMock,
}));

vi.mock('@services/NativeService', () => ({
    native: nativeMock,
}));

vi.mock('@services/NotificationService', () => ({
    notify: vi.fn(),
}));

vi.mock('@components/AlertMessage.vue', () => ({
    default: {
        name: 'AlertMessageStub',
        template: '<div />',
        methods: {
            success: vi.fn(),
            error: vi.fn(),
            warning: vi.fn(),
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

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelectStub',
        props: ['modelValue', 'options'],
        emits: ['update:modelValue'],
        template: '<select data-testid="custom-select"><option>{{ modelValue }}</option></select>',
    },
}));

describe('SettingsGeneralSection', () => {
    beforeEach(() => {
        nativeMock.shortcut.getShortcutStatus.mockResolvedValue([false, null]);
        nativeMock.autostart.isAutostartEnabled.mockResolvedValue(false);
    });

    it('renders the general settings groups and row controls', () => {
        const wrapper = mount(GeneralSection);

        expect(wrapper.get('h1').text()).toBe('通用');
        expect(wrapper.text()).toContain('快捷键');
        expect(wrapper.text()).toContain('唤起快捷键');
        expect(wrapper.text()).toContain('Alt+Space');
        expect(wrapper.text()).toContain('Ctrl+Space');
        expect(wrapper.text()).toContain('启动与窗口');
        expect(wrapper.text()).toContain('开机自启动');
        expect(wrapper.text()).toContain('启动时最小化');
        expect(wrapper.text()).toContain('窗口尺寸');
        expect(wrapper.text()).toContain('对话体验');
        expect(wrapper.text()).toContain('输出时滚动策略');
        expect(wrapper.text()).toContain('界面语言');
        expect(wrapper.text()).not.toContain('快捷唤起');
        expect(wrapper.text()).not.toContain('管理全局唤起');
        expect(wrapper.text()).not.toContain('启动设置');
        expect(wrapper.text()).not.toContain('系统启动时自动运行TouchAI');
        expect(wrapper.text()).not.toContain('启动后隐藏到系统托盘');
        expect(wrapper.text()).not.toContain('默认窗口规格');
        expect(wrapper.text()).not.toContain('支持的修饰键');
        expect(wrapper.find('[data-testid="settings-brand-accent"]').exists()).toBe(false);

        const controls = wrapper.findAll('[data-testid="settings-general-control"]');
        expect(controls.length).toBeGreaterThanOrEqual(3);

        const rowLabels = wrapper.findAll('[data-testid="settings-general-row-label"]');
        expect(rowLabels).toHaveLength(6);
    });

    it('shows a compact occupied-shortcut indicator inside the fixed-width control area', async () => {
        nativeMock.shortcut.getShortcutStatus.mockResolvedValueOnce([true, 'occupied']);
        const wrapper = mount(GeneralSection);

        await flushPromises();

        expect(wrapper.find('[data-testid="settings-shortcut-error"]').exists()).toBe(false);
        expect(
            wrapper.get('[data-testid="settings-shortcut-occupied-indicator"]').attributes('title')
        ).toBe('快捷键注册失败，可能已被其他应用占用');
        expect(wrapper.find('[data-testid="settings-shortcut-retry-button"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-shortcut-cancel-button"]').exists()).toBe(
            false
        );
    });
});
