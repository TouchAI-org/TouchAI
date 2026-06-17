import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import { setLocale } from '@/i18n';
import { AppEvent, eventService } from '@/services/EventService';
import GeneralSection from '@/views/SettingsView/components/Shortcuts/index.vue';

const originalPlatform = navigator.platform;

function setPlatform(platform: string) {
    Object.defineProperty(window.navigator, 'platform', {
        configurable: true,
        value: platform,
    });
}

const settingsStoreMock = vi.hoisted(() => {
    const createGeneralSettingsMock = (searchKeybindings: Record<string, string | null>) => ({
        globalShortcut: 'Alt+Space',
        searchKeybindings: {
            ...searchKeybindings,
        },
        startOnBoot: false,
        startMinimized: true,
        language: 'zh-CN',
        outputScrollBehavior: 'follow_output',
        searchWindowSizePreset: 'normal',
        searchWindowDefaultSize: { width: 720, height: 520 },
        appUpdateChannel: 'stable',
        appUpdateAutoCheck: true,
        appUpdateLastCheckedAt: null,
    });

    return {
        createGeneralSettingsMock,
        settings: {
            value: createGeneralSettingsMock({}),
        },
        initialize: vi.fn().mockResolvedValue(undefined),
        updateGlobalShortcut: vi.fn().mockResolvedValue(undefined),
        updateSearchKeybindings: vi.fn().mockResolvedValue(undefined),
        updateStartOnBoot: vi.fn().mockResolvedValue(undefined),
        updateStartMinimized: vi.fn().mockResolvedValue(undefined),
        updateOutputScrollBehavior: vi.fn().mockResolvedValue(undefined),
        updateSearchWindowSizePreset: vi.fn().mockResolvedValue(undefined),
        updateLanguage: vi.fn().mockResolvedValue(undefined),
        updateAppUpdateChannel: vi.fn().mockResolvedValue(undefined),
        updateAppUpdateAutoCheck: vi.fn().mockResolvedValue(undefined),
        updateAppUpdateLastCheckedAt: vi.fn().mockResolvedValue(undefined),
    };
});

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

const alertMessageMock = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
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
            success: alertMessageMock.success,
            error: alertMessageMock.error,
            warning: alertMessageMock.warning,
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
        props: ['modelValue', 'options', 'open', 'contentTestId', 'optionTestIdPrefix'],
        emits: ['update:modelValue', 'update:open'],
        template: `
            <div data-testid="custom-select">
                <slot name="trigger" />
                <select v-if="!$slots.trigger" data-testid="custom-select-native">
                    <option>{{ modelValue }}</option>
                </select>
                <div v-if="open" :data-testid="contentTestId">
                    <button
                        v-for="option in options"
                        :key="option.value"
                        type="button"
                        :data-testid="optionTestIdPrefix ? optionTestIdPrefix + option.value : undefined"
                        @click="$emit('update:modelValue', option.value)"
                    >
                        {{ option.label }}
                    </button>
                </div>
            </div>
        `,
    },
}));

describe('SettingsShortcutsSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setPlatform('Win32');
        setLocale('zh-CN');
        nativeMock.shortcut.getShortcutStatus.mockResolvedValue([false, null]);
        nativeMock.autostart.isAutostartEnabled.mockResolvedValue(false);
        settingsStoreMock.settings.value = settingsStoreMock.createGeneralSettingsMock(
            createDefaultSearchKeybindings()
        );
    });

    afterEach(() => {
        setPlatform(originalPlatform);
        document.body.innerHTML = '';
    });

    it('renders the shortcuts settings groups in the browser settings layout', async () => {
        const wrapper = mount(GeneralSection);

        await flushPromises();

        expect(wrapper.get('h1').text()).toBe('快捷键');
        expect(wrapper.get('[data-testid="shortcuts-settings-title"]').text()).toBe('快捷键');
        expect(wrapper.get('.settings-page-header').classes()).toEqual(
            expect.arrayContaining(['flex', 'items-start', 'gap-4'])
        );
        expect(wrapper.get('.settings-section-description').text()).toBe('全局呼出与搜索快捷键');
        expect(wrapper.find('.settings-page-description').exists()).toBe(false);
        expect(wrapper.text()).toContain('快捷键');
        expect(wrapper.text()).toContain('唤起快捷键');
        expect(wrapper.text()).toContain('全局呼出与搜索快捷键');
        expect(
            (
                wrapper.get('[data-testid="settings-global-shortcut-input"]')
                    .element as HTMLInputElement
            ).value
        ).toBe('Alt+Space');
        const sections = wrapper.findAll('section');
        expect(sections).toHaveLength(2);
        expect(sections[0].classes()).toEqual(expect.arrayContaining(['space-y-4']));
        expect(sections[1].classes()).toEqual(expect.arrayContaining(['mt-10', 'space-y-4']));
        expect(wrapper.findAll('.settings-section-title').map((heading) => heading.text())).toEqual(
            ['全局唤起', '搜索快捷键']
        );

        expect(wrapper.text()).toContain('全局呼出快捷键');
        expect(wrapper.text()).not.toContain('Ctrl+Space');
        expect(wrapper.find('[data-testid="settings-shortcut-suggestions"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-global-shortcut-preset-menu"]').exists()).toBe(
            false
        );
        expect(wrapper.text()).toContain(
            '自定义搜索窗口内的命令型快捷键，不会影响输入导航与全局唤起。'
        );
        expect(wrapper.text()).toContain('会话');
        expect(wrapper.text()).toContain('输入与请求');
        expect(wrapper.text()).toContain('窗口');
        expect(wrapper.text()).toContain('打开会话历史');
        expect(wrapper.text()).toContain('快速打开或收起会话历史列表');
        expect(wrapper.text()).toContain('开始新会话');
        expect(wrapper.text()).toContain('切换窗口最大化');
        expect(wrapper.text()).toContain('切换搜索窗口最大化');
        expect(wrapper.text()).toContain('打开设置');
        expect(wrapper.text()).toContain('快速打开设置窗口');
        expect(
            (
                wrapper.get('[data-testid="settings-search-shortcut-input-search.window.maximize"]')
                    .element as HTMLInputElement
            ).value
        ).toBe('F11');
        expect(
            (
                wrapper.get('[data-testid="settings-search-shortcut-input-search.settings.open"]')
                    .element as HTMLInputElement
            ).value
        ).toBe('Ctrl+,');
        expect(
            (
                wrapper.get('[data-testid="settings-search-shortcut-input-search.request.cancel"]')
                    .element as HTMLInputElement
            ).value
        ).toBe('Esc');
        expect(
            wrapper
                .get('[data-testid="settings-search-shortcut-input-search.history.open"]')
                .classes()
        ).not.toContain('font-mono');
        expect(wrapper.text()).not.toContain('启动与窗口');
        expect(wrapper.text()).not.toContain('界面语言');
        expect(wrapper.text()).not.toContain('版本更新通道');
        expect(wrapper.text()).not.toContain('快捷唤起');
        expect(wrapper.text()).not.toContain('管理全局唤起');
        expect(wrapper.text()).not.toContain('启动设置');
        expect(wrapper.text()).not.toContain('支持的修饰键');
        expect(wrapper.find('[data-testid="settings-brand-accent"]').exists()).toBe(false);

        const controls = wrapper.findAll('[data-testid="settings-general-control"]');
        expect(controls.length).toBeGreaterThanOrEqual(1);

        const rowLabels = wrapper.findAll('[data-testid="settings-general-row-label"]');
        expect(rowLabels.length).toBeGreaterThanOrEqual(10);
    });

    it('opens global shortcut presets from the shortcut field and saves a preset', async () => {
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get('[data-testid="settings-global-shortcut-input"]');
        await input.trigger('focus');
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-global-shortcut-preset-menu"]').exists()).toBe(
            true
        );
        expect(
            wrapper.get('[data-testid="settings-global-shortcut-preset-Alt+Space"]').text()
        ).toBe('Alt+Space');
        expect(
            wrapper.get('[data-testid="settings-global-shortcut-preset-Ctrl+Space"]').text()
        ).toBe('Ctrl+Space');

        await wrapper
            .get('[data-testid="settings-global-shortcut-preset-Ctrl+Space"]')
            .trigger('click');
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith('Ctrl+Space');
        expect(settingsStoreMock.updateGlobalShortcut).toHaveBeenCalledWith('Ctrl+Space');
        expect((input.element as HTMLInputElement).value).toBe('Ctrl+Space');
        expect(settingsStoreMock.settings.value.globalShortcut).toBe('Ctrl+Space');
        expect(wrapper.find('[data-testid="settings-global-shortcut-preset-menu"]').exists()).toBe(
            false
        );
    });

    it('uses macOS shortcut labels and omits input-method-conflicting presets', async () => {
        setPlatform('MacIntel');
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get('[data-testid="settings-global-shortcut-input"]');
        expect((input.element as HTMLInputElement).value).toBe('Option+Space');

        await input.trigger('focus');
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-global-shortcut-preset-menu"]').exists()).toBe(
            true
        );
        expect(
            wrapper.get('[data-testid="settings-global-shortcut-preset-Option+Space"]').text()
        ).toBe('Option+Space');
        expect(
            wrapper.get('[data-testid="settings-global-shortcut-preset-Option+Shift+Space"]').text()
        ).toBe('Option+Shift+Space');
        expect(
            wrapper.find('[data-testid="settings-global-shortcut-preset-Ctrl+Space"]').exists()
        ).toBe(false);

        await wrapper
            .get('[data-testid="settings-global-shortcut-preset-Option+Shift+Space"]')
            .trigger('click');
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith(
            'Option+Shift+Space'
        );
        expect(settingsStoreMock.updateGlobalShortcut).toHaveBeenCalledWith('Option+Shift+Space');
        expect((input.element as HTMLInputElement).value).toBe('Option+Shift+Space');
    });

    it('blocks macOS system-reserved global shortcuts before registration', async () => {
        setPlatform('MacIntel');
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get('[data-testid="settings-global-shortcut-input"]');
        await input.trigger('focus');
        await flushPromises();

        window.dispatchEvent(
            new KeyboardEvent('keydown', { key: ' ', code: 'Space', metaKey: true })
        );
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
        expect(settingsStoreMock.updateGlobalShortcut).not.toHaveBeenCalled();
        expect((input.element as HTMLInputElement).value).toBe('Option+Space');

        await input.trigger('focus');
        await flushPromises();
        window.dispatchEvent(
            new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true })
        );
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
        expect(settingsStoreMock.updateGlobalShortcut).not.toHaveBeenCalled();
        expect((input.element as HTMLInputElement).value).toBe('Option+Space');
    });

    it('rejects macOS system-reserved search shortcuts', async () => {
        setPlatform('MacIntel');
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get(
            '[data-testid="settings-search-shortcut-input-search.history.open"]'
        );
        await input.trigger('focus');
        await flushPromises();
        alertMessageMock.error.mockClear();

        window.dispatchEvent(
            new KeyboardEvent('keydown', { key: ' ', code: 'Space', metaKey: true })
        );
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).not.toHaveBeenCalled();
        expect(alertMessageMock.error).toHaveBeenCalledWith(expect.stringContaining('macOS'), 3000);
        expect((input.element as HTMLInputElement).value).toBe('Cmd+H');

        window.dispatchEvent(
            new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true })
        );
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).not.toHaveBeenCalled();
        expect((input.element as HTMLInputElement).value).toBe('Cmd+H');
    });

    it('saves the global shortcut immediately after a shortcut is pressed', async () => {
        settingsStoreMock.settings.value.searchKeybindings['search.session.new'] = 'Mod+Shift+N';
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get('[data-testid="settings-global-shortcut-input"]');
        await input.trigger('focus');
        await flushPromises();

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }));
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith('Ctrl+N');
        expect(settingsStoreMock.updateGlobalShortcut).toHaveBeenCalledWith('Ctrl+N');
        expect(wrapper.find('[data-testid="settings-global-shortcut-preset-menu"]').exists()).toBe(
            false
        );
    });

    it('captures Ctrl+Space from the global shortcut input before the preset menu handles Space', async () => {
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get('[data-testid="settings-global-shortcut-input"]');
        await input.trigger('focus');
        await flushPromises();

        await input.trigger('keydown', {
            key: ' ',
            code: 'Space',
            ctrlKey: true,
        });
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).toHaveBeenCalledWith('Ctrl+Space');
        expect(settingsStoreMock.updateGlobalShortcut).toHaveBeenCalledWith('Ctrl+Space');
        expect((input.element as HTMLInputElement).value).toBe('Ctrl+Space');
        expect(settingsStoreMock.settings.value.globalShortcut).toBe('Ctrl+Space');
    });

    it('does not capture navigation keys while global shortcut presets are open', async () => {
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get('[data-testid="settings-global-shortcut-input"]');
        await input.trigger('focus');
        await flushPromises();

        const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
        window.dispatchEvent(event);
        await flushPromises();

        expect(event.defaultPrevented).toBe(false);
        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
        expect(settingsStoreMock.updateGlobalShortcut).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="settings-global-shortcut-preset-menu"]').exists()).toBe(
            true
        );

        wrapper.unmount();
    });

    it('reports invalid global shortcut attempts only once through the capture stack', async () => {
        const wrapper = mount(GeneralSection, {
            attachTo: document.body,
        });

        await flushPromises();

        const input = wrapper.get('[data-testid="settings-global-shortcut-input"]');
        await input.trigger('focus');
        await flushPromises();
        alertMessageMock.warning.mockClear();

        const event = new KeyboardEvent('keydown', {
            key: 'a',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        input.element.dispatchEvent(event);
        await flushPromises();

        expect(event.defaultPrevented).toBe(true);
        expect(alertMessageMock.warning).toHaveBeenCalledTimes(1);
        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
        expect(settingsStoreMock.updateGlobalShortcut).not.toHaveBeenCalled();

        wrapper.unmount();
    });

    it('does not save a global shortcut that duplicates a search shortcut', async () => {
        settingsStoreMock.settings.value.searchKeybindings['search.history.open'] = 'Mod+A';
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get('[data-testid="settings-global-shortcut-input"]');
        await input.trigger('focus');
        await flushPromises();

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
        await flushPromises();

        expect(nativeMock.shortcut.registerGlobalShortcut).not.toHaveBeenCalled();
        expect(settingsStoreMock.updateGlobalShortcut).not.toHaveBeenCalled();
        expect((input.element as HTMLInputElement).value).toBe('Alt+Space');
    });
    it('accepts modifierless function keys for configurable search shortcuts', async () => {
        settingsStoreMock.settings.value.searchKeybindings['search.history.open'] = 'Mod+Shift+H';
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get(
            '[data-testid="settings-search-shortcut-input-search.history.open"]'
        );
        await input.trigger('focus');
        await flushPromises();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1' }));
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).toHaveBeenCalledWith({
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': 'F1',
        });
    });

    it('captures Windows system key events while editing a search shortcut', async () => {
        settingsStoreMock.settings.value.globalShortcut = 'Ctrl+Space';
        settingsStoreMock.settings.value.searchKeybindings['search.history.open'] = 'Mod+Shift+H';
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get(
            '[data-testid="settings-search-shortcut-input-search.history.open"]'
        );
        await input.trigger('focus');
        await flushPromises();

        await eventService.emit(AppEvent.SHORTCUT_CAPTURE_SYSTEM_KEY, {
            key: 'Space',
            alt: true,
            ctrl: false,
            shift: false,
        });
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).toHaveBeenCalledWith({
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': 'Alt+Space',
        });
    });

    it('captures a function-row key by keyboard code when the key value is not an F-key', async () => {
        settingsStoreMock.settings.value.searchKeybindings['search.history.open'] = 'Mod+Shift+H';
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get(
            '[data-testid="settings-search-shortcut-input-search.history.open"]'
        );
        await input.trigger('focus');
        await flushPromises();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'BrightnessUp', code: 'F2' }));
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).toHaveBeenCalledWith({
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': 'F2',
        });
    });

    it('does not capture navigation keys while editing a search shortcut', async () => {
        settingsStoreMock.settings.value.searchKeybindings['search.history.open'] = 'Mod+Shift+H';
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get(
            '[data-testid="settings-search-shortcut-input-search.history.open"]'
        );
        await input.trigger('focus');
        await flushPromises();

        const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
        window.dispatchEvent(event);
        await flushPromises();

        expect(event.defaultPrevented).toBe(false);
        expect(settingsStoreMock.updateSearchKeybindings).not.toHaveBeenCalled();

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1' }));
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).toHaveBeenCalledWith({
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': 'F1',
        });
    });

    it('keeps search shortcut capture active after a validation failure', async () => {
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get(
            '[data-testid="settings-search-shortcut-input-search.history.open"]'
        );
        await input.trigger('focus');
        await flushPromises();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', shiftKey: true }));
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).not.toHaveBeenCalled();

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1' }));
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).toHaveBeenCalledWith({
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': 'F1',
        });
    });

    it('captures shifted punctuation shortcuts through their physical key code', async () => {
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get(
            '[data-testid="settings-search-shortcut-input-search.history.open"]'
        );
        await input.trigger('focus');
        await flushPromises();

        window.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: '+',
                code: 'Equal',
                ctrlKey: true,
                shiftKey: true,
            })
        );
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).toHaveBeenCalledWith({
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': 'Mod+Shift+=',
        });
        expect((input.element as HTMLInputElement).value).toBe('Ctrl+Shift+=');
    });

    it('reports unsupported mac command search shortcuts without showing the Windows key warning', async () => {
        setPlatform('MacIntel');
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get(
            '[data-testid="settings-search-shortcut-input-search.history.open"]'
        );
        await input.trigger('focus');
        await flushPromises();
        alertMessageMock.error.mockClear();
        alertMessageMock.warning.mockClear();

        window.dispatchEvent(new KeyboardEvent('keydown', { key: '@', metaKey: true }));
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).not.toHaveBeenCalled();
        expect(alertMessageMock.warning).not.toHaveBeenCalled();
        expect(alertMessageMock.error).toHaveBeenCalledTimes(1);
        expect((input.element as HTMLInputElement).value).toBe('Cmd+H');

        wrapper.unmount();
    });

    it('shows fixed search shortcuts as unsupported for editing', async () => {
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const input = wrapper.get('[data-testid="settings-search-shortcut-input-search.submit"]');
        expect(input.attributes('title')).toBe('暂不支持修改该快捷键');
        expect(input.attributes('tabindex')).toBe('-1');

        await input.trigger('focus');
        await flushPromises();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).not.toHaveBeenCalled();
        expect((input.element as HTMLInputElement).value).toBe('Enter');
    });

    it('uses an inline x icon to clear a default search shortcut', async () => {
        const wrapper = mount(GeneralSection);

        await flushPromises();

        expect(
            wrapper
                .find('[data-testid="settings-search-shortcut-reset-search.history.open"]')
                .exists()
        ).toBe(false);
        expect(
            wrapper
                .find('[data-testid="settings-search-shortcut-disable-search.history.open"]')
                .exists()
        ).toBe(false);

        const action = wrapper.get(
            '[data-testid="settings-search-shortcut-action-search.history.open"]'
        );
        expect(action.attributes('data-shortcut-action')).toBe('clear');
        expect(action.get('[data-testid="app-icon"]').attributes('data-name')).toBe('x');

        await action.trigger('click');
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).toHaveBeenCalledWith({
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': null,
        });
    });

    it('uses an inline undo icon to restore non-default search shortcuts', async () => {
        settingsStoreMock.settings.value.searchKeybindings['search.history.open'] = 'Mod+Shift+H';
        const wrapper = mount(GeneralSection);

        await flushPromises();

        const action = wrapper.get(
            '[data-testid="settings-search-shortcut-action-search.history.open"]'
        );
        expect(action.attributes('data-shortcut-action')).toBe('restore');
        expect(action.get('[data-testid="app-icon"]').attributes('data-name')).toBe('undo');

        await action.trigger('click');
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).toHaveBeenCalledWith({
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': 'Mod+H',
        });
    });

    it('restores the default search shortcut from the cleared state', async () => {
        const clearedSearchKeybindings = {
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': null,
        };
        settingsStoreMock.settings.value.searchKeybindings = clearedSearchKeybindings;
        const wrapper = mount(GeneralSection);

        await flushPromises();

        expect(
            (
                wrapper.get('[data-testid="settings-search-shortcut-input-search.history.open"]')
                    .element as HTMLInputElement
            ).value
        ).toBe('无');

        const action = wrapper.get(
            '[data-testid="settings-search-shortcut-action-search.history.open"]'
        );
        expect(action.attributes('data-shortcut-action')).toBe('restore');
        expect(action.get('[data-testid="app-icon"]').attributes('data-name')).toBe('undo');

        await action.trigger('click');
        await flushPromises();

        expect(settingsStoreMock.updateSearchKeybindings).toHaveBeenCalledWith({
            ...clearedSearchKeybindings,
            'search.history.open': 'Mod+H',
        });
    });

    it('localizes the cleared search shortcut fallback', async () => {
        setLocale('en-US');
        settingsStoreMock.settings.value.language = 'en-US';
        settingsStoreMock.settings.value.searchKeybindings = {
            ...settingsStoreMock.settings.value.searchKeybindings,
            'search.history.open': null,
        };

        const wrapper = mount(GeneralSection);

        await flushPromises();

        expect(
            (
                wrapper.get('[data-testid="settings-search-shortcut-input-search.history.open"]')
                    .element as HTMLInputElement
            ).value
        ).toBe('None');
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
