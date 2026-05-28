import type { AppUpdateState } from '@services/AppUpdateService/types';
import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import GeneralSection from '@/views/SettingsView/components/General/index.vue';

const settingsStoreMock = vi.hoisted(() => ({
    settings: {
        value: {
            globalShortcut: 'Alt+Space',
            startOnBoot: false,
            startMinimized: true,
            language: 'zh-CN',
            outputScrollBehavior: 'follow_output',
            searchWindowSizePreset: 'normal',
            searchWindowDefaultSize: { width: 720, height: 520 },
            appUpdateChannel: 'stable',
            appUpdateAutoCheck: true,
            appUpdateLastCheckedAt: null,
        },
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    updateGlobalShortcut: vi.fn().mockResolvedValue(undefined),
    updateStartOnBoot: vi.fn().mockResolvedValue(undefined),
    updateStartMinimized: vi.fn().mockResolvedValue(undefined),
    updateOutputScrollBehavior: vi.fn().mockResolvedValue(undefined),
    updateSearchWindowSizePreset: vi.fn().mockResolvedValue(undefined),
    updateLanguage: vi.fn().mockResolvedValue(undefined),
    updateAppUpdateChannel: vi.fn().mockResolvedValue(undefined),
    updateAppUpdateAutoCheck: vi.fn().mockResolvedValue(undefined),
    updateAppUpdateLastCheckedAt: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@components/MarkdownContent.vue', () => ({
    default: {
        name: 'MarkdownContentStub',
        props: ['content'],
        template: '<div data-testid="markdown-content">{{ content }}</div>',
    },
}));

vi.mock('@tauri-apps/api/app', () => ({
    getVersion: vi.fn().mockResolvedValue('0.1.0'),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn().mockResolvedValue(undefined),
}));

const appUpdateServiceMock = vi.hoisted(() => {
    const createState = (): AppUpdateState => ({
        status: 'not_available',
        channel: 'stable',
        autoCheckEnabled: true,
        currentVersion: '0.1.0',
        availableUpdate: null,
        downloadedUpdate: null,
        latestUpdate: null,
        updateRequirement: null,
        downloadProgress: null,
        lastCheckedAt: '2026-05-22T10:00:00.000Z',
        error: null,
        unsupportedReason: null,
    });

    return {
        createState,
        state: createState(),
        getState: vi.fn(() => appUpdateServiceMock.state),
        subscribe: vi.fn((listener) => {
            listener(appUpdateServiceMock.state);
            return () => undefined;
        }),
        initialize: vi.fn().mockResolvedValue(undefined),
        checkNow: vi.fn().mockResolvedValue(true),
        download: vi.fn().mockResolvedValue(true),
        install: vi.fn().mockResolvedValue(true),
        setChannel: vi.fn().mockResolvedValue(undefined),
        setAutoCheckEnabled: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('@services/AppUpdateService', () => ({
    appUpdateService: appUpdateServiceMock,
}));

describe('SettingsGeneralSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        appUpdateServiceMock.state = appUpdateServiceMock.createState();
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
        expect(wrapper.text()).toContain('版本更新通道');
        expect(wrapper.text()).toContain('选择您适合的版本更新频率');
        expect(wrapper.text()).toContain('当前已是最新版');
        expect(wrapper.text()).toContain('自动检查更新');
        expect(wrapper.text()).toContain('检查更新');
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
        expect(rowLabels).toHaveLength(8);
    });

    it('delegates auto-check toggle changes', async () => {
        const wrapper = mount(GeneralSection);

        await flushPromises();
        await wrapper.get('[data-testid="settings-update-auto-check-toggle"]').trigger('click');

        expect(appUpdateServiceMock.setAutoCheckEnabled).toHaveBeenCalledWith(false);
    });

    it('shows update details and delegates update actions', async () => {
        appUpdateServiceMock.state = {
            ...appUpdateServiceMock.state,
            status: 'available',
            currentVersion: '0.1.0',
            availableUpdate: {
                version: '0.2.0',
                fileName: 'TouchAI-0.2.0-windows-full.nupkg',
                notes: '## 更新日志\n\n- 修复问题',
                sizeBytes: 10,
            },
            latestUpdate: {
                version: '0.2.0',
                tag: 'v0.2.0',
                releaseUrl: 'https://updates.touch-ai.org/touchai-app/v1/releases.stable.json',
                publishedAt: '2026-05-22T09:00:00.000Z',
                prerelease: false,
                releaseNotes: '## 更新日志\n\n- 修复问题',
                downloads: [],
            },
            updateRequirement: {
                required: false,
                minimumSupportedVersion: null,
                requiredSeverity: null,
                requiredReason: null,
                targetSatisfiesRequirement: true,
            },
        };
        const wrapper = mount(GeneralSection);

        await flushPromises();
        await wrapper.get('[data-testid="settings-update-primary-action"]').trigger('click');

        expect(wrapper.text()).toContain('已有新版本：V0.2.0（Stable）');
        expect(wrapper.text()).toContain('当前版本 V0.1.0，目标版本 V0.2.0');

        await wrapper.get('[data-testid="settings-update-dialog-primary"]').trigger('click');
        expect(appUpdateServiceMock.download).toHaveBeenCalledTimes(1);
    });

    it('shows failed update state and retries with a manual check', async () => {
        appUpdateServiceMock.state = {
            ...appUpdateServiceMock.createState(),
            status: 'failed',
            error: 'Network error',
        };
        const wrapper = mount(GeneralSection);

        await flushPromises();

        expect(wrapper.text()).toContain('更新检查失败');
        expect(wrapper.text()).toContain('Network error');
        expect(wrapper.get('[data-testid="settings-update-primary-action"]').text()).toContain(
            '检查更新'
        );

        await wrapper.get('[data-testid="settings-update-primary-action"]').trigger('click');

        expect(appUpdateServiceMock.checkNow).toHaveBeenCalledWith('manual');
        expect(appUpdateServiceMock.download).not.toHaveBeenCalled();
        expect(appUpdateServiceMock.install).not.toHaveBeenCalled();
    });

    it('shows unsupported update state without exposing download or install actions', async () => {
        appUpdateServiceMock.state = {
            ...appUpdateServiceMock.createState(),
            status: 'unsupported',
            unsupportedReason: 'platform_unsupported',
        };
        const wrapper = mount(GeneralSection);

        await flushPromises();

        expect(wrapper.text()).toContain('当前运行方式暂不支持应用内更新');
        expect(wrapper.get('[data-testid="settings-update-primary-action"]').text()).toContain(
            '检查更新'
        );

        await wrapper.get('[data-testid="settings-update-primary-action"]').trigger('click');

        expect(appUpdateServiceMock.checkNow).toHaveBeenCalledWith('manual');
        expect(appUpdateServiceMock.download).not.toHaveBeenCalled();
        expect(appUpdateServiceMock.install).not.toHaveBeenCalled();
    });

    it('keeps required available updates on the in-app download path', async () => {
        appUpdateServiceMock.state = {
            ...appUpdateServiceMock.createState(),
            status: 'available',
            currentVersion: '0.1.0',
            availableUpdate: {
                version: '0.2.1',
                fileName: 'TouchAI-0.2.1-windows-full.nupkg',
                notes: '## 安全更新\n\n- 修复安全问题',
                sizeBytes: 10,
            },
            latestUpdate: {
                version: '0.2.1',
                tag: 'v0.2.1',
                releaseUrl: 'https://updates.touch-ai.org/touchai-app/v1/releases.stable.json',
                publishedAt: '2026-05-22T09:00:00.000Z',
                prerelease: false,
                releaseNotes: '## 安全更新\n\n- 修复安全问题',
                downloads: [],
            },
            updateRequirement: {
                required: true,
                minimumSupportedVersion: '0.2.1',
                requiredSeverity: 'security',
                requiredReason: 'Security update required',
                targetSatisfiesRequirement: true,
            },
        };
        const wrapper = mount(GeneralSection);

        await flushPromises();
        await wrapper.get('[data-testid="settings-update-primary-action"]').trigger('click');

        expect(wrapper.text()).toContain('已有新版本：V0.2.1（Stable）');
        expect(wrapper.text()).toContain('当前版本 V0.1.0，目标版本 V0.2.1');

        await wrapper.get('[data-testid="settings-update-dialog-primary"]').trigger('click');

        expect(appUpdateServiceMock.download).toHaveBeenCalledTimes(1);
        expect(appUpdateServiceMock.install).not.toHaveBeenCalled();
    });

    it('shows downloading progress in the details dialog and disables the action', async () => {
        appUpdateServiceMock.state = {
            ...appUpdateServiceMock.createState(),
            status: 'downloading',
            downloadProgress: 42,
            availableUpdate: {
                version: '0.2.0',
                fileName: 'TouchAI-0.2.0-windows-full.nupkg',
                notes: '## 更新日志\n\n- 修复问题',
                sizeBytes: 10,
            },
            latestUpdate: {
                version: '0.2.0',
                tag: 'v0.2.0',
                releaseUrl: 'https://updates.touch-ai.org/touchai-app/v1/releases.stable.json',
                publishedAt: '2026-05-22T09:00:00.000Z',
                prerelease: false,
                releaseNotes: '## 更新日志\n\n- 修复问题',
                downloads: [],
            },
        };
        const wrapper = mount(GeneralSection);

        await flushPromises();

        expect(wrapper.text()).toContain('正在下载更新 42%');
        await wrapper.get('[data-testid="settings-update-primary-action"]').trigger('click');

        const dialogPrimary = wrapper.get('[data-testid="settings-update-dialog-primary"]');
        expect(dialogPrimary.text()).toContain('正在下载 42%');
        expect(dialogPrimary.attributes('disabled')).toBeDefined();
    });

    it('shows installing state in the details dialog and disables the action', async () => {
        appUpdateServiceMock.state = {
            ...appUpdateServiceMock.createState(),
            status: 'installing',
            downloadedUpdate: {
                version: '0.2.0',
                fileName: 'TouchAI-0.2.0-windows-full.nupkg',
                notes: '## 更新日志\n\n- 修复问题',
                sizeBytes: 10,
            },
            latestUpdate: {
                version: '0.2.0',
                tag: 'v0.2.0',
                releaseUrl: 'https://updates.touch-ai.org/touchai-app/v1/releases.stable.json',
                publishedAt: '2026-05-22T09:00:00.000Z',
                prerelease: false,
                releaseNotes: '## 更新日志\n\n- 修复问题',
                downloads: [],
            },
        };
        const wrapper = mount(GeneralSection);

        await flushPromises();

        expect(wrapper.text()).toContain('正在安装并重启...');
        await wrapper.get('[data-testid="settings-update-primary-action"]').trigger('click');

        const dialogPrimary = wrapper.get('[data-testid="settings-update-dialog-primary"]');
        expect(dialogPrimary.text()).toContain('正在安装');
        expect(dialogPrimary.attributes('disabled')).toBeDefined();
    });

    it('falls back to empty release-note text when latest metadata has no notes', async () => {
        appUpdateServiceMock.state = {
            ...appUpdateServiceMock.createState(),
            status: 'available',
            currentVersion: '0.1.0',
            latestUpdate: {
                version: '0.2.0',
                tag: 'v0.2.0',
                releaseUrl: 'https://updates.touch-ai.org/touchai-app/v1/releases.stable.json',
                publishedAt: '2026-05-22T09:00:00.000Z',
                prerelease: false,
                releaseNotes: '',
                downloads: [],
            },
            updateRequirement: {
                required: false,
                minimumSupportedVersion: null,
                requiredSeverity: null,
                requiredReason: null,
                targetSatisfiesRequirement: true,
            },
        };
        const wrapper = mount(GeneralSection);

        await flushPromises();
        await wrapper.get('[data-testid="settings-update-primary-action"]').trigger('click');

        expect(wrapper.text()).toContain('暂无更新日志');
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
