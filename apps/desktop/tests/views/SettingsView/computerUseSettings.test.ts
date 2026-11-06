import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ComputerUseSettings from '@/views/SettingsView/components/ComputerUse/index.vue';

const state = vi.hoisted(() => {
    const settings = {
        allowForeground: false,
        allowedApps: [] as string[],
        approval: 'each' as 'each' | 'session-window',
        cursorVisible: true,
        enabled: false,
        maxImageDimension: 1568,
        recordingEnabled: false,
        telemetryEnabled: false,
    };

    return {
        applySettings: vi.fn(async () => [] as string[]),
        checkUpdate: vi.fn(),
        confirm: vi.fn(async () => true),
        loadSettings: vi.fn(async () => settings),
        loadStats: vi.fn(async () => ({
            actions: 4,
            avgDurationMs: 20,
            denied: 1,
            durationSamples: 2,
            foregroundEscalations: 0,
            successes: 3,
        })),
        prepare: vi.fn(),
        remove: vi.fn(),
        saveSettings: vi.fn(async (patch: Record<string, unknown>) => {
            Object.assign(settings, patch);
            return settings;
        }),
        setRecording: vi.fn(async (enabled: boolean) => {
            void enabled;
            return undefined;
        }),
        settings,
        status: vi.fn(async () => ({
            abiVersion: '1.1.0',
            binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
            driverVersion: '0.38.0',
            error: null,
            installed: false,
        })),
    };
});

const settings = state.settings;
const { applySettings, checkUpdate, confirm, prepare, remove, saveSettings, status } = state;

vi.mock('@services/ComputerUseService', () => ({
    computerUseService: {
        applySettings: () => state.applySettings(),
        checkUpdate: () => state.checkUpdate(),
        clearSessionApprovals: vi.fn(),
        loadSettings: () => state.loadSettings(),
        loadStats: () => state.loadStats(),
        prepare: () => state.prepare(),
        remove: () => state.remove(),
        saveSettings: (patch: Record<string, unknown>) => state.saveSettings(patch),
        setRecording: (enabled: boolean) => state.setRecording(enabled),
        status: () => state.status(),
    },
    DEFAULT_SETTINGS: state.settings,
}));

vi.mock('@composables/useConfirm', () => ({ useConfirm: () => ({ confirm: state.confirm }) }));

enableAutoUnmount(afterEach);

const stubs = {
    AppIcon: true,
    Button: {
        props: ['disabled', 'variant', 'size'],
        template: '<button @click="$emit(\'click\')"><slot /></button>',
    },
    Input: {
        props: ['modelValue'],
        template: '<input :value="modelValue" @change="$emit(\'change\', $event)" />',
    },
    Switch: {
        props: ['modelValue'],
        template:
            '<button class="switch-stub" @click="$emit(\'update:modelValue\', !modelValue)" />',
    },
};

async function mountPage() {
    const wrapper = mount(ComputerUseSettings, { global: { stubs } });
    await flush();
    return wrapper;
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    settings.approval = 'each';
    saveSettings.mockClear();
    prepare.mockReset();
    remove.mockReset();
    checkUpdate.mockReset();
    applySettings.mockClear();
    status.mockClear();
    confirm.mockClear();
});

describe('computer use settings section', () => {
    it('user sees the driver as missing before it is installed', async () => {
        const wrapper = await mountPage();

        expect(wrapper.text()).toContain('未安装');
        expect(wrapper.text()).toContain('0.38.0');
        expect(wrapper.text()).toContain('1.1.0');
    });

    it('user installs the driver and sees it become ready', async () => {
        prepare.mockResolvedValue({
            abiVersion: '1.1.0',
            binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
            driverVersion: '0.38.0',
            error: null,
            installed: true,
        });
        const wrapper = await mountPage();

        await wrapper
            .findAll('button')
            .find((node) => node.text() === '下载并启用')!
            .trigger('click');
        await flush();

        expect(prepare).toHaveBeenCalledTimes(1);
        expect(applySettings).toHaveBeenCalledTimes(1);
        expect(wrapper.text()).toContain('已就绪');
    });

    it('user sees a download failure instead of a silent no-op', async () => {
        prepare.mockResolvedValue({
            abiVersion: null,
            binary: null,
            driverVersion: null,
            error: 'download failed after 3 attempts',
            installed: false,
        });
        const wrapper = await mountPage();

        await wrapper
            .findAll('button')
            .find((node) => node.text() === '下载并启用')!
            .trigger('click');
        await flush();

        expect(wrapper.text()).toContain('download failed after 3 attempts');
    });

    it('user switching approval granularity is stored', async () => {
        const wrapper = await mountPage();

        await wrapper
            .findAll('button')
            .find((node) => node.text().includes('本窗口本会话'))!
            .trigger('click');
        await flush();

        expect(saveSettings).toHaveBeenCalledWith({ approval: 'session-window' });
    });

    it('user changing the max screenshot edge pushes it to the driver', async () => {
        const wrapper = await mountPage();

        const input = wrapper.get('input[type="number"]');
        await input.setValue('900');
        await input.trigger('change');
        await flush();

        expect(saveSettings).toHaveBeenCalledWith({ maxImageDimension: 900 });
        expect(applySettings).toHaveBeenCalled();
    });

    it('user checking for updates sees the newer version', async () => {
        checkUpdate.mockResolvedValue({
            current: '0.38.0',
            error: null,
            latest: '0.39.0',
            updateAvailable: true,
        });
        const wrapper = await mountPage();

        await wrapper
            .findAll('button')
            .find((node) => node.text() === '检查更新')!
            .trigger('click');
        await flush();

        expect(wrapper.text()).toContain('有新版本 0.39.0');
    });

    it('user removing the driver confirms first and refreshes the state', async () => {
        remove.mockResolvedValue(undefined);
        const wrapper = await mountPage();

        await wrapper
            .findAll('button')
            .find((node) => node.text() === '移除驱动')!
            .trigger('click');
        await flush();

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(status).toHaveBeenCalledTimes(2);
        expect(wrapper.text()).toContain('已移除');
    });

    it('user sees the statistics collected so far', async () => {
        const wrapper = await mountPage();

        expect(wrapper.text()).toContain('75%');
        expect(wrapper.text()).toContain('20 ms');
    });
});
