import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale, t } from '@/i18n';
import type { ComputerUseStatus } from '@/services/ComputerUseService';
import type { ComputerUseDriverId } from '@/services/NativeService/computerUse';
import ComputerUseSettings from '@/views/SettingsView/components/ComputerUse/index.vue';

const state = vi.hoisted(() => {
    const settings = {
        allowForeground: true,
        allowedApps: [] as string[],
        approval: 'each' as 'each' | 'session-window' | 'full-access',
        cursorVisible: true,
        enabled: false,
        maxImageDimension: 1568,
        recordingEnabled: false,
        telemetryEnabled: false,
    };

    return {
        alert: {
            error: vi.fn(),
            success: vi.fn(),
            warning: vi.fn(),
        },
        applySettings: vi.fn(async () => [] as string[]),
        checkUpdate: vi.fn(),
        installUpdate: vi.fn(),
        clearSessionApprovals: vi.fn(),
        confirm: vi.fn(async () => true),
        loadSettings: vi.fn(async () => settings),
        loadDriver: vi.fn(async () => 'cua-driver'),
        selectDriver: vi.fn<(driver: string) => Promise<void>>().mockResolvedValue(undefined),
        isEnabled: vi.fn(async () => true),
        loadGroups: vi.fn(async () => ({ clipboard: false })),
        driverDirectory: '',
        loadDriverDirectory: vi.fn(async (): Promise<string> => state.driverDirectory),
        saveDriverDirectory: vi.fn(async (directory: string): Promise<string> => {
            state.driverDirectory = directory;
            return directory;
        }),
        recordingDirectory: 'C:/cache/computer-use-trajectories/cua-driver',
        loadRecordingDirectory: vi.fn(async (): Promise<string> => state.recordingDirectory),
        saveRecordingDirectory: vi.fn(async (directory: string): Promise<string> => {
            state.recordingDirectory = directory;
            return directory;
        }),
        openDirectory: vi.fn<(options: unknown) => Promise<string | null>>(),
        setEnabled: vi.fn<(enabled: boolean) => Promise<void>>().mockResolvedValue(undefined),
        setGroupEnabled: vi
            .fn<(group: string, enabled: boolean) => Promise<void>>()
            .mockResolvedValue(undefined),
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
        status: vi
            .fn<(driver: ComputerUseDriverId) => Promise<ComputerUseStatus>>()
            .mockResolvedValue({
                abiVersion: '1.1.0',
                binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
                driverVersion: '0.38.0',
                error: null,
                installed: true,
            }),
    };
});

const settings = state.settings;
const {
    applySettings,
    checkUpdate,
    confirm,
    installUpdate,
    prepare,
    remove,
    saveSettings,
    status,
} = state;

vi.mock('@services/ComputerUseService', () => ({
    computerUseService: {
        applySettings: () => state.applySettings(),
        checkUpdate: (driver: string) => state.checkUpdate(driver),
        installUpdate: (driver: string, version: string) => state.installUpdate(driver, version),
        clearSessionApprovals: () => state.clearSessionApprovals(),
        loadSettings: () => state.loadSettings(),
        loadDriver: () => state.loadDriver(),
        selectDriver: (driver: string) => state.selectDriver(driver),
        isEnabled: () => state.isEnabled(),
        loadGroups: () => state.loadGroups(),
        loadDriverDirectory: () => state.loadDriverDirectory(),
        saveDriverDirectory: (directory: string) => state.saveDriverDirectory(directory),
        loadRecordingDirectory: () => state.loadRecordingDirectory(),
        saveRecordingDirectory: (directory: string) => state.saveRecordingDirectory(directory),
        setEnabled: (enabled: boolean) => state.setEnabled(enabled),
        setGroupEnabled: (group: string, enabled: boolean) => state.setGroupEnabled(group, enabled),
        prepare: (driver: string) => state.prepare(driver),
        remove: (driver: string) => state.remove(driver),
        saveSettings: (patch: Record<string, unknown>) => state.saveSettings(patch),
        setRecording: (enabled: boolean) => state.setRecording(enabled),
        status: (driver: ComputerUseDriverId) => state.status(driver),
    },
    DEFAULT_SETTINGS: state.settings,
}));

vi.mock('@composables/useAlert', () => ({ useAlert: () => state.alert }));
vi.mock('@composables/useConfirm', () => ({ useConfirm: () => ({ confirm: state.confirm }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: (options: unknown) => state.openDirectory(options),
}));

enableAutoUnmount(afterEach);

const stubs = {
    Button: {
        props: ['disabled', 'variant', 'size'],
        template: '<button :disabled="disabled"><slot /></button>',
    },
    CustomSelect: {
        name: 'CustomSelect',
        props: ['modelValue', 'options', 'triggerTestId', 'contentTestId'],
        emits: ['update:modelValue'],
        template:
            '<div><select :data-testid="triggerTestId" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">{{ option.label }}</option></select><slot name="trigger" :option="options.find(option => option.value === modelValue)" /><div :data-testid="contentTestId"><div v-for="option in options" :key="option.value" role="group" :aria-label="option.label"><slot name="option-actions" :option="option" /></div></div></div>',
    },
    Switch: {
        props: ['modelValue'],
        template:
            '<button class="switch-stub" :aria-checked="modelValue" @click="$emit(\'update:modelValue\', !modelValue)" />',
    },
};

async function mountPage() {
    const wrapper = mount(ComputerUseSettings, { global: { stubs } });
    await flush();
    return wrapper;
}

async function mountDriverMenu() {
    const wrapper = mount(ComputerUseSettings, { attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-testid="computer-use-driver-select"]').trigger('keydown', {
        key: 'Enter',
    });
    await flushPromises();
    return wrapper;
}

async function flush() {
    await flushPromises();
}

beforeEach(() => {
    setLocale('zh-CN');
    state.driverDirectory = '';
    state.loadDriverDirectory.mockClear();
    state.saveDriverDirectory.mockClear();
    state.isEnabled.mockResolvedValue(true);
    state.loadDriver.mockResolvedValue('cua-driver');
    state.selectDriver.mockReset();
    state.selectDriver.mockImplementation(async (driver: string) => {
        state.loadDriver.mockResolvedValue(driver);
        state.recordingDirectory = `C:/cache/computer-use-trajectories/${driver}`;
    });
    state.setEnabled.mockReset().mockResolvedValue(undefined);
    state.setGroupEnabled.mockReset().mockResolvedValue(undefined);
    settings.approval = 'each';
    settings.allowForeground = true;
    settings.cursorVisible = true;
    settings.maxImageDimension = 1568;
    settings.recordingEnabled = false;
    state.recordingDirectory = 'C:/cache/computer-use-trajectories/cua-driver';
    state.loadRecordingDirectory.mockClear();
    state.saveRecordingDirectory.mockClear();
    state.openDirectory.mockReset();
    state.setRecording.mockReset();
    state.alert.error.mockClear();
    state.alert.success.mockClear();
    state.alert.warning.mockClear();
    state.clearSessionApprovals.mockClear();
    saveSettings.mockReset().mockImplementation(async (patch: Record<string, unknown>) => {
        Object.assign(settings, patch);
        return settings;
    });
    prepare.mockReset();
    remove.mockReset();
    checkUpdate.mockReset();
    installUpdate.mockReset();
    applySettings.mockClear();
    status.mockReset();
    status.mockResolvedValue({
        abiVersion: '1.1.0',
        binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
        driverVersion: '0.38.0',
        error: null,
        installed: true,
    });
    confirm.mockClear();
});

describe('computer use settings section', () => {
    it.each([
        ['zh-CN', '基础', '显示当前 Agent 操作的光标', 'Agent 截图识别时的清晰度'],
        [
            'en-US',
            'Basics',
            'Show where the agent is acting',
            'Screenshot sharpness for agent recognition',
        ],
    ] as const)(
        'user given computer control settings in %s when opening then sees basics and short cursor and screenshot explanations',
        async (locale, heading, cursorHint, screenshotHint) => {
            setLocale(locale);
            const wrapper = await mountPage();
            const section = wrapper.get('section[aria-labelledby="computer-use-driver-heading"]');
            expect(section.get('h2').text()).toBe(heading);
            expect(
                section.get('[data-settings-search-target="computer-use-cursor"]').text()
            ).toContain(cursorHint);
            expect(
                section.get('[data-settings-search-target="computer-use-max-image"]').text()
            ).toContain(screenshotHint);
        }
    );

    it.each([
        ['zh-CN', '驱动保存位置', '使用默认位置'],
        ['en-US', 'Driver location', 'Use default location'],
    ] as const)(
        'user given no driver location when opening settings in %s then sees an empty field without an internal path',
        async (locale, label, placeholder) => {
            setLocale(locale);
            const wrapper = await mountPage();
            const input = wrapper.get<HTMLInputElement>(
                '[data-testid="computer-use-driver-directory"]'
            );
            expect(wrapper.get('label[for="computer-use-driver-directory"]').text()).toBe(label);
            expect(input.element.value).toBe('');
            expect(input.attributes('placeholder')).toBe(placeholder);
            expect(input.attributes('title')).toBe('');
            expect(state.saveDriverDirectory).not.toHaveBeenCalled();
            expect(
                wrapper.find('[data-testid="computer-use-driver-directory-reset"]').exists()
            ).toBe(false);
        }
    );

    it('user given a driver location when restoring default then sees an empty field after reopening', async () => {
        state.driverDirectory = 'D:/drivers';
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-driver-directory-reset"]').trigger('click');
        await flush();
        expect(state.saveDriverDirectory).toHaveBeenCalledWith('');
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-driver-directory"]').element
                .value
        ).toBe('');
        wrapper.unmount();
        const reopened = await mountPage();
        expect(
            reopened.get<HTMLInputElement>('[data-testid="computer-use-driver-directory"]').element
                .value
        ).toBe('');
    });

    it('user given a failed location reset when restoring default then retains the custom path and can retry', async () => {
        state.driverDirectory = 'D:/drivers';
        state.saveDriverDirectory.mockRejectedValueOnce(new Error('Reset failed'));
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-driver-directory-reset"]').trigger('click');
        await flush();
        expect(state.alert.error).toHaveBeenCalledWith('Reset failed');
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-driver-directory"]').element
                .value
        ).toBe('D:/drivers');
        expect(
            wrapper
                .get('[data-testid="computer-use-driver-directory-reset"]')
                .element.matches(':disabled')
        ).toBe(false);
    });

    it.each([
        ['zh-CN', '32.8 MB'],
        ['en-US', '32.8 MB'],
    ] as const)(
        'user given installed and missing drivers when opening the %s list then sees actual size only beside the installed driver',
        async (locale, cuaSize) => {
            setLocale(locale);
            status.mockImplementation(async (driver) => ({
                abiVersion: null,
                binary: null,
                driverVersion: driver === 'cua-driver' ? '0.38.0' : null,
                installedSizeBytes: driver === 'cua-driver' ? 32842600 : null,
                error: null,
                installed: driver === 'cua-driver',
            }));
            await mountDriverMenu();
            const cua = document.querySelector('[role="group"][aria-label="cua-driver"]');
            const agent = document.querySelector('[role="group"][aria-label="agent-desktop"]');
            expect(cua?.textContent).toContain(`v0.38.0 ${cuaSize}`);
            expect(agent?.textContent).not.toContain('MB');
        }
    );

    it('user given unknown installation sizes when opening the list then sees no invented size', async () => {
        await mountDriverMenu();
        const menu = document.querySelector('[data-testid="computer-use-driver-options"]');
        expect(menu?.textContent).not.toContain('MB');
        expect(menu?.textContent).not.toContain('NaN');
    });

    it.each([
        ['computer-use-enabled-toggle', 'enabled'],
        ['computer-use-group-input', 'group'],
        ['computer-use-foreground-toggle', 'preference'],
        ['computer-use-cursor-toggle', 'preference'],
        ['computer-use-recording-toggle', 'recording'],
    ] as const)(
        'user given a pending %s change when editing another switch then only the pending switch is disabled and failure unlocks it',
        async (testId, operation) => {
            let rejectSave!: (error: Error) => void;
            const pending = new Promise<never>((_resolve, reject) => {
                rejectSave = reject;
            });
            if (operation === 'enabled') state.setEnabled.mockReturnValueOnce(pending);
            else if (operation === 'group') state.setGroupEnabled.mockReturnValueOnce(pending);
            else if (operation === 'recording') state.setRecording.mockReturnValueOnce(pending);
            else state.saveSettings.mockReturnValueOnce(pending);
            const wrapper = mount(ComputerUseSettings, { attachTo: document.body });
            await flush();
            const control = wrapper.get(`[data-testid="${testId}"]`);
            await control.trigger('click');
            await flush();
            const disabled = wrapper
                .findAll('button, input')
                .filter((element) => element.element.matches(':disabled'))
                .map((element) => element.attributes('data-testid'));
            expect(disabled).toEqual([testId]);
            await wrapper.get('[data-testid="computer-use-group-clipboard"]').trigger('click');
            await flush();
            expect(state.setGroupEnabled).toHaveBeenCalledWith('clipboard', true);
            expect(control.element.matches(':disabled')).toBe(true);
            rejectSave(new Error('Settings unavailable'));
            await flush();
            expect(control.element.matches(':disabled')).toBe(false);
            expect(state.alert.error).toHaveBeenCalledWith('Settings unavailable');
        }
    );

    it('user given two preference writes completing out of order when both finish then keeps both displayed choices', async () => {
        settings.allowForeground = false;
        let finishForeground!: (value: typeof settings) => void;
        saveSettings.mockReturnValueOnce(
            new Promise((resolve) => {
                finishForeground = resolve;
            })
        );
        saveSettings.mockResolvedValueOnce({
            ...settings,
            allowForeground: true,
            cursorVisible: false,
        });
        const wrapper = mount(ComputerUseSettings, { attachTo: document.body });
        await flush();
        await wrapper.get('[data-testid="computer-use-foreground-toggle"]').trigger('click');
        await wrapper.get('[data-testid="computer-use-cursor-toggle"]').trigger('click');
        await flush();
        finishForeground({ ...settings, allowForeground: true, cursorVisible: true });
        await flush();
        expect(
            wrapper.get('[data-testid="computer-use-foreground-toggle"]').attributes('aria-checked')
        ).toBe('true');
        expect(
            wrapper.get('[data-testid="computer-use-cursor-toggle"]').attributes('aria-checked')
        ).toBe('false');
    });

    it('user given no installed drivers when choosing a storage folder then retains the new location after reopening', async () => {
        status.mockResolvedValue({
            installed: false,
            error: null,
            abiVersion: null,
            binary: null,
            driverVersion: null,
        });
        state.openDirectory.mockResolvedValueOnce('D:/驱动');
        const wrapper = await mountPage();
        const picker = wrapper.get('[data-testid="computer-use-driver-directory-pick"]');
        expect(picker.element.matches(':disabled')).toBe(false);
        await picker.trigger('click');
        await flush();
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-driver-directory"]').element
                .value
        ).toBe('D:/驱动');
        wrapper.unmount();
        const reopened = await mountPage();
        expect(
            reopened.get<HTMLInputElement>('[data-testid="computer-use-driver-directory"]').element
                .value
        ).toBe('D:/驱动');
    });

    it('user given a storage move in progress when it fails then keeps the old folder and unlocks settings', async () => {
        state.driverDirectory = 'D:/drivers';
        let rejectMove!: (error: Error) => void;
        state.saveDriverDirectory.mockReturnValueOnce(
            new Promise((_resolve, reject) => {
                rejectMove = reject;
            })
        );
        state.openDirectory.mockResolvedValueOnce('D:/occupied');
        const wrapper = mount(ComputerUseSettings, { attachTo: document.body });
        await flush();
        await wrapper.get('[data-testid="computer-use-driver-directory-pick"]').trigger('click');
        await flush();
        expect(
            wrapper
                .findAll('button, input')
                .every((control) => control.element.matches(':disabled'))
        ).toBe(true);
        rejectMove(new Error('Destination contains a driver'));
        await flush();
        expect(state.alert.error).toHaveBeenCalledWith('Destination contains a driver');
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-driver-directory"]').element
                .value
        ).toBe('D:/drivers');
        expect(
            wrapper
                .get('[data-testid="computer-use-driver-directory-pick"]')
                .element.matches(':disabled')
        ).toBe(false);
    });

    it('user given a storage folder when cancelling the picker then preserves the directory', async () => {
        state.openDirectory.mockResolvedValueOnce(null);
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-driver-directory-pick"]').trigger('click');
        await flush();
        expect(state.saveDriverDirectory).not.toHaveBeenCalled();
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-driver-directory"]').element
                .value
        ).toBe('');
    });
    it('user given an uninstalled driver when viewing its option then cannot select it but can download it', async () => {
        status.mockImplementation(async (driver) => ({
            installed: driver === 'cua-driver',
            error: null,
            abiVersion: null,
            binary: null,
            driverVersion: driver === 'cua-driver' ? '0.38.0' : null,
        }));
        const wrapper = await mountDriverMenu();
        const group = document.querySelector('[role="group"][aria-label="agent-desktop"]')!;
        const option = group.querySelector('[role="option"]')!;
        expect(option.getAttribute('aria-disabled')).toBe('true');
        option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await flush();
        expect(wrapper.get('[data-testid="computer-use-driver-select"]').text()).toContain(
            'cua-driver'
        );
        expect(state.selectDriver).not.toHaveBeenCalled();
        expect(
            group.querySelector<HTMLButtonElement>('[data-testid="computer-use-install"]')?.disabled
        ).toBe(false);
    });

    it('user given no usable drivers when opening then keeps disabled preferences and can install a driver', async () => {
        status.mockResolvedValue({
            installed: false,
            error: null,
            abiVersion: null,
            binary: null,
            driverVersion: null,
        });
        const wrapper = await mountDriverMenu();
        expect(wrapper.text()).not.toContain('暂无可用驱动，请先下载并安装。');
        expect(wrapper.find('[data-testid="computer-use-no-driver"]').exists()).toBe(false);
        expect(wrapper.findAll('h2').map((heading) => heading.text())).toEqual(['基础', '权限']);
        expect(document.querySelectorAll('[data-testid="computer-use-install"]')).toHaveLength(2);
        expect(wrapper.get('[data-testid="computer-use-recording-toggle"]').isVisible()).toBe(true);
        for (const control of wrapper.findAll(
            'section:not(:first-child) button, section:not(:first-child) input'
        )) {
            expect(control.element.matches(':disabled')).toBe(true);
        }
        expect(
            document.querySelector('[data-testid="computer-use-install"]')?.matches(':disabled')
        ).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-status"]').exists()).toBe(false);
    });

    it('user given no installed driver when the first download finishes then sees the installed choice without an extra notice', async () => {
        status.mockResolvedValue({
            installed: false,
            error: null,
            abiVersion: null,
            binary: null,
            driverVersion: null,
        });
        prepare.mockImplementation(async (driver: ComputerUseDriverId) => {
            const ready = {
                installed: true,
                error: null,
                abiVersion: null,
                binary: 'agent-desktop.exe',
                driverVersion: '1.2.0',
            };
            status.mockImplementation(async (candidate) => ({
                ...ready,
                installed: candidate === driver,
            }));
            return ready;
        });
        const wrapper = await mountPage();
        await wrapper
            .get('[role="group"][aria-label="agent-desktop"] [data-testid="computer-use-install"]')
            .trigger('click');
        await flush();
        expect(wrapper.find('[data-testid="computer-use-no-driver"]').exists()).toBe(false);
        expect(
            (wrapper.get('[data-testid="computer-use-driver-select"]').element as HTMLSelectElement)
                .value
        ).toBe('agent-desktop');
        expect(wrapper.find('[data-testid="computer-use-recording-toggle"]').exists()).toBe(true);
    });

    it('user given the last installed driver when deleting then keeps preferences visible and disabled', async () => {
        status.mockImplementation(async (driver) => ({
            installed: driver === 'cua-driver',
            error: null,
            abiVersion: null,
            binary: null,
            driverVersion: null,
        }));
        remove.mockImplementation(async () => {
            status.mockResolvedValue({
                installed: false,
                error: null,
                abiVersion: null,
                binary: null,
                driverVersion: null,
            });
        });
        settings.recordingEnabled = true;
        const wrapper = await mountDriverMenu();
        const approval = wrapper.get('[data-testid="computer-use-approval-mode"]').element;
        const recording = wrapper.get('[data-testid="computer-use-recording-toggle"]').element;
        document.querySelector<HTMLButtonElement>('[data-testid="computer-use-remove"]')!.click();
        await flush();
        expect(wrapper.find('[data-testid="computer-use-no-driver"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="computer-use-driver-select"]').text()).toContain(
            '选择驱动'
        );
        expect(wrapper.get('[data-testid="computer-use-approval-mode"]').element).toBe(approval);
        expect(wrapper.get('[data-testid="computer-use-recording-toggle"]').element).toBe(
            recording
        );
        expect(approval.matches(':disabled')).toBe(true);
        expect(recording.matches(':disabled')).toBe(true);
        expect(recording.getAttribute('aria-checked')).toBe('true');
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-recording-directory"]')
                .element.value
        ).toBe(state.recordingDirectory);
        expect(
            wrapper.get('[data-testid="computer-use-driver-select"]').element.matches(':disabled')
        ).toBe(false);
    });

    it('user given a pending removal when confirming then keeps the page disabled until refreshed and recovers after failure', async () => {
        let confirmRemoval!: (value: boolean) => void;
        let failRemoval!: (error: Error) => void;
        confirm.mockReturnValueOnce(
            new Promise<boolean>((resolve) => {
                confirmRemoval = resolve;
            })
        );
        remove.mockReturnValueOnce(
            new Promise((_resolve, reject) => {
                failRemoval = reject;
            })
        );
        settings.recordingEnabled = true;
        const wrapper = await mountDriverMenu();
        const controls = wrapper.findAll('button, input').map((control) => control.element);
        document.querySelector<HTMLButtonElement>('[data-testid="computer-use-remove"]')!.click();
        await flush();
        for (const control of controls) expect(control.matches(':disabled')).toBe(true);
        expect(wrapper.findAll('h2').map((heading) => heading.text())).toEqual(['基础', '权限']);
        confirmRemoval(true);
        await flush();
        for (const control of controls) expect(control.matches(':disabled')).toBe(true);
        failRemoval(new Error('Access denied'));
        await flush();
        expect(state.alert.error).toHaveBeenCalledWith('Access denied');
        for (const control of controls) {
            expect(wrapper.element.contains(control)).toBe(true);
            expect(control.matches(':disabled')).toBe(false);
        }
        expect(wrapper.get('[data-testid="computer-use-driver-select"]').text()).toContain(
            'cua-driver'
        );
    });

    it('user given two installed drivers when switching then sees the chosen driver and only its supported preferences', async () => {
        settings.recordingEnabled = true;
        settings.approval = 'session-window';
        const wrapper = await mountPage();
        const select = wrapper.get('[data-testid="computer-use-driver-select"]');
        await select.setValue('agent-desktop');
        await flush();
        expect(state.selectDriver).toHaveBeenCalledWith('agent-desktop');
        expect((select.element as HTMLSelectElement).value).toBe('agent-desktop');
        expect(wrapper.find('[data-testid="computer-use-max-image"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-group-browser"]').exists()).toBe(false);
        expect(wrapper.text()).toContain('批量操作');
        expect(wrapper.text()).toContain('轨迹查看与导出');
        expect(wrapper.text()).not.toContain('批量与脚本');
        expect(wrapper.text()).not.toContain('录制与回放工具');
        expect(wrapper.get('[data-testid="computer-use-approval-mode"]').text()).not.toContain(
            t('settings.computerUse.approval.session')
        );
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-recording-directory"]')
                .element.value
        ).toContain('agent-desktop');
        await select.setValue('cua-driver');
        await flush();
        expect(wrapper.find('[data-testid="computer-use-max-image"]').exists()).toBe(true);
        expect(wrapper.text()).toContain('批量与脚本');
    });

    it('user given two driver options when checking the second one then checks its update without switching the active driver', async () => {
        checkUpdate.mockResolvedValue({ error: null, updateAvailable: false });
        const wrapper = await mountPage();
        await wrapper
            .get(
                '[role="group"][aria-label="agent-desktop"] [data-testid="computer-use-check-update"]'
            )
            .trigger('click');
        await flush();
        expect(checkUpdate).toHaveBeenCalledWith('agent-desktop');
        expect(
            (wrapper.get('[data-testid="computer-use-driver-select"]').element as HTMLSelectElement)
                .value
        ).toBe('cua-driver');
    });
    it('user given computer control settings when opening then sees the heading and a short explanation', async () => {
        const wrapper = await mountPage();
        expect(wrapper.get('h1').text()).toBe('电脑控制');
        expect(wrapper.get('header p').text()).toBe(t('settings.nav.computerUse.description'));
    });
    it('user given enabled computer control when toggling the header switch then disables its preferences', async () => {
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-enabled-toggle"]').trigger('click');
        await flush();
        expect(state.setEnabled).toHaveBeenCalledWith(false);
        expect(wrapper.get('fieldset').attributes()).toHaveProperty('disabled');
    });

    it('user given computer control settings when reviewing permissions then finds confirmation and capabilities in one section', async () => {
        const wrapper = await mountPage();
        const section = wrapper.get('section[aria-labelledby="computer-use-permission-heading"]');
        expect(wrapper.findAll('h2').map((heading) => heading.text())).toEqual(['基础', '权限']);
        expect(section.text()).toContain('权限模式');
        expect(section.find('[data-testid="computer-use-approval-mode"]').exists()).toBe(true);
        expect(section.findAll('[data-testid^="computer-use-group-"]')).toHaveLength(8);
        expect(
            section.get('[data-testid="computer-use-foreground-toggle"]').attributes('aria-checked')
        ).toBe('true');
        const driver = wrapper.get('section[aria-labelledby="computer-use-driver-heading"]');
        expect(driver.find('[data-testid="computer-use-foreground-toggle"]').exists()).toBe(false);
        expect(driver.text()).toContain('录制轨迹');
        expect(driver.find('[data-testid="computer-use-cursor-toggle"]').exists()).toBe(true);
        expect(driver.find('[data-testid="computer-use-max-image"]').exists()).toBe(true);
        expect(section.text()).toContain('录制与回放工具');
    });

    it('user given disabled clipboard tools when toggling their group then saves the group without changing other groups', async () => {
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-group-clipboard"]').trigger('click');
        await flush();
        expect(state.setGroupEnabled).toHaveBeenCalledWith('clipboard', true);
    });

    it('user given recording is off when enabling and disabling it then sees the saved location only while enabled', async () => {
        const wrapper = await mountPage();
        expect(wrapper.find('[data-testid="computer-use-recording-directory"]').exists()).toBe(
            false
        );
        await wrapper.get('[data-testid="computer-use-recording-toggle"]').trigger('click');
        await flushPromises();
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-recording-directory"]')
                .element.value
        ).toBe(state.recordingDirectory);
        expect(settings.recordingEnabled).toBe(true);
        await wrapper.get('[data-testid="computer-use-recording-toggle"]').trigger('click');
        await flushPromises();
        expect(wrapper.find('[data-testid="computer-use-recording-directory"]').exists()).toBe(
            false
        );
        expect(settings.recordingEnabled).toBe(false);
    });

    it('user given recording is enabled when choosing another folder then sees and retains the selected location', async () => {
        settings.recordingEnabled = true;
        state.openDirectory.mockResolvedValueOnce('C:/用户记录/电脑控制');
        const wrapper = await mountPage();
        await flushPromises();
        await wrapper.get('[data-testid="computer-use-recording-directory-pick"]').trigger('click');
        await flushPromises();
        expect(state.openDirectory).toHaveBeenCalledWith(
            expect.objectContaining({
                directory: true,
                multiple: false,
                defaultPath: 'C:/cache/computer-use-trajectories/cua-driver',
            })
        );
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-recording-directory"]')
                .element.value
        ).toBe('C:/用户记录/电脑控制');
        wrapper.unmount();
        const reopened = await mountPage();
        await flushPromises();
        expect(
            reopened.get<HTMLInputElement>('[data-testid="computer-use-recording-directory"]')
                .element.value
        ).toBe('C:/用户记录/电脑控制');
    });

    it('user given a recording location when cancelling the folder dialog then keeps that location', async () => {
        settings.recordingEnabled = true;
        state.openDirectory.mockResolvedValueOnce(null);
        const wrapper = await mountPage();
        await flushPromises();
        await wrapper.get('[data-testid="computer-use-recording-directory-pick"]').trigger('click');
        await flushPromises();
        expect(state.saveRecordingDirectory).not.toHaveBeenCalled();
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-recording-directory"]')
                .element.value
        ).toBe(state.recordingDirectory);
    });

    it('user given an unwritable folder when selecting it then sees the failure and can retry with the old location intact', async () => {
        settings.recordingEnabled = true;
        state.openDirectory.mockResolvedValueOnce('C:/unwritable');
        state.saveRecordingDirectory.mockRejectedValueOnce(new Error('Access denied'));
        const wrapper = await mountPage();
        await flushPromises();
        const picker = wrapper.get('[data-testid="computer-use-recording-directory-pick"]');
        await picker.trigger('click');
        await flushPromises();
        expect(state.alert.error).toHaveBeenCalledWith('Access denied');
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-recording-directory"]')
                .element.value
        ).toBe(state.recordingDirectory);
        expect(picker.attributes()).not.toHaveProperty('disabled');
    });

    it('user given a recording start failure when enabling then keeps recording disabled and the location hidden', async () => {
        state.setRecording.mockRejectedValueOnce(new Error('Recording unavailable'));
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-recording-toggle"]').trigger('click');
        await flushPromises();
        expect(state.alert.error).toHaveBeenCalledWith('Recording unavailable');
        expect(settings.recordingEnabled).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-recording-directory"]').exists()).toBe(
            false
        );
    });
    it('user sees the driver as missing before it is installed', async () => {
        status.mockResolvedValue({
            abiVersion: null,
            binary: null,
            driverVersion: null,
            error: null,
            installed: false,
        });
        const wrapper = await mountPage();

        expect(wrapper.find('[data-testid="computer-use-status"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-install"]').exists()).toBe(true);
    });

    it('user installs the driver and sees it become ready', async () => {
        status.mockResolvedValue({
            abiVersion: null,
            binary: null,
            driverVersion: null,
            error: null,
            installed: false,
        });
        prepare.mockResolvedValue({
            abiVersion: '1.1.0',
            binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
            driverVersion: '0.38.0',
            error: null,
            installed: true,
        });
        const wrapper = await mountPage();

        await wrapper.get('[data-testid="computer-use-install"]').trigger('click');
        await flush();

        expect(prepare).toHaveBeenCalledTimes(1);
        expect(applySettings).toHaveBeenCalledTimes(1);
        expect(state.alert.success).toHaveBeenCalledWith(
            t('settings.computerUse.status.installed')
        );
    });

    it('user given a missing driver when downloading then sees loading until installation completes and cannot start it twice', async () => {
        status.mockResolvedValueOnce({
            abiVersion: null,
            binary: null,
            driverVersion: null,
            error: null,
            installed: false,
        });
        let finishDownload!: (value: ComputerUseStatus) => void;
        prepare.mockReturnValueOnce(
            new Promise<ComputerUseStatus>((resolve) => {
                finishDownload = resolve;
            })
        );
        const wrapper = await mountDriverMenu();
        const action = document.querySelector<HTMLButtonElement>(
            '[data-testid="computer-use-install"]'
        )!;
        expect(action).not.toBeNull();

        action.click();
        action.click();
        await flushPromises();

        expect(action.getAttribute('aria-busy')).toBe('true');
        expect(action.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
            t('common.loading')
        );
        expect(action.disabled).toBe(true);
        expect(document.body.contains(action)).toBe(true);
        expect(prepare).toHaveBeenCalledTimes(1);

        finishDownload({
            abiVersion: '1.1.0',
            binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
            driverVersion: '0.38.0',
            error: null,
            installed: true,
        });
        await flushPromises();

        expect(document.querySelector('[data-testid="computer-use-install"]')).toBeNull();
        expect(wrapper.get('[data-testid="computer-use-driver-select"]').text()).toContain(
            'cua-driver'
        );
        expect(document.body.textContent).toContain('v0.38.0');
        expect(
            document
                .querySelector('[data-testid="computer-use-check-update"]')
                ?.hasAttribute('disabled')
        ).toBe(false);
    });

    it('user given a download in progress when reopening the driver list then sees loading and cannot switch or start another download', async () => {
        status.mockImplementation(async (driver) => ({
            abiVersion: null,
            binary: null,
            driverVersion: driver === 'agent-desktop' ? '1.2.0' : null,
            error: null,
            installed: driver === 'agent-desktop',
        }));
        let finishDownload!: (value: ComputerUseStatus) => void;
        prepare.mockReturnValueOnce(
            new Promise<ComputerUseStatus>((resolve) => {
                finishDownload = resolve;
            })
        );
        const wrapper = await mountDriverMenu();
        document.querySelector<HTMLButtonElement>('[data-testid="computer-use-install"]')!.click();
        await flush();
        const trigger = wrapper.get('[data-testid="computer-use-driver-select"]');
        expect(trigger.element.matches(':disabled')).toBe(false);
        await trigger.trigger('keydown', { key: 'Escape' });
        await flush();
        expect(trigger.attributes('aria-expanded')).toBe('false');
        await trigger.trigger('keydown', { key: 'Enter' });
        await flush();
        expect(trigger.attributes('aria-expanded')).toBe('true');
        const downloading = document.querySelector<HTMLButtonElement>(
            '[data-testid="computer-use-install"]'
        )!;
        expect(downloading.getAttribute('aria-busy')).toBe('true');
        expect(downloading.querySelector('[role="status"]')).not.toBeNull();
        expect(downloading.disabled).toBe(true);
        const other = document.querySelector('[role="group"][aria-label="agent-desktop"]')!;
        expect(other.querySelector('[role="option"]')?.getAttribute('aria-disabled')).toBe('true');
        other
            .querySelector('[role="option"]')!
            .dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        downloading.click();
        await flush();
        expect(state.selectDriver).not.toHaveBeenCalled();
        expect(prepare).toHaveBeenCalledTimes(1);
        finishDownload({
            abiVersion: null,
            binary: null,
            driverVersion: '0.38.0',
            error: null,
            installed: true,
        });
        await flush();
        expect(trigger.element.matches(':disabled')).toBe(false);
        expect(trigger.text()).toContain('cua-driver');
        expect(document.querySelector('[role="status"]')).toBeNull();
    });

    it.each(['rejected', 'reported'])(
        'user given a pending download when it fails as %s then loading stops and download can be retried',
        async (failure) => {
            const missing: ComputerUseStatus = {
                abiVersion: null,
                binary: null,
                driverVersion: null,
                error: null,
                installed: false,
            };
            status.mockResolvedValueOnce(missing);
            let failDownload!: () => void;
            prepare.mockReturnValueOnce(
                new Promise<ComputerUseStatus>((resolve, reject) => {
                    failDownload = () => {
                        if (failure === 'rejected') reject(new Error('Download unavailable'));
                        else resolve({ ...missing, error: 'Download unavailable' });
                    };
                })
            );
            await mountDriverMenu();
            const action = document.querySelector<HTMLButtonElement>(
                '[data-testid="computer-use-install"]'
            )!;
            action.click();
            await flushPromises();
            expect(action.getAttribute('aria-busy')).toBe('true');

            failDownload();
            await flushPromises();

            expect(action.getAttribute('aria-busy')).toBe('false');
            expect(action.querySelector('[role="status"]')).toBeNull();
            expect(action.disabled).toBe(false);
            expect(action.getAttribute('aria-label')).toBe(
                `${t('settings.computerUse.action.prepare')} · cua-driver`
            );
            expect(state.alert.error).toHaveBeenCalledWith('Download unavailable');
            prepare.mockResolvedValueOnce({ ...missing, error: 'Still unavailable' });
            action.click();
            await flushPromises();
            expect(state.alert.error).toHaveBeenLastCalledWith('Still unavailable');
        }
    );

    it('user sees a download failure instead of a silent no-op', async () => {
        status.mockResolvedValueOnce({
            abiVersion: null,
            binary: null,
            driverVersion: null,
            error: null,
            installed: false,
        });
        prepare.mockResolvedValue({
            abiVersion: null,
            binary: null,
            driverVersion: null,
            error: 'download failed after 3 attempts',
            installed: false,
        });
        const wrapper = await mountPage();

        await wrapper.get('[data-testid="computer-use-install"]').trigger('click');
        await flush();

        expect(state.alert.error).toHaveBeenCalledWith('download failed after 3 attempts');
    });

    it('user switching approval granularity is stored', async () => {
        const wrapper = await mountPage();

        await wrapper.get('[data-testid="computer-use-approval-mode"]').setValue('session-window');
        await flush();

        expect(saveSettings).toHaveBeenCalledWith({ approval: 'session-window' });
        expect(state.clearSessionApprovals).toHaveBeenCalledTimes(1);
    });

    it('user selecting full access turns off approval prompts and clears old grants', async () => {
        const wrapper = await mountPage();

        await wrapper.get('[data-testid="computer-use-approval-mode"]').setValue('full-access');
        await flush();

        expect(saveSettings).toHaveBeenCalledWith({ approval: 'full-access' });
        expect(state.clearSessionApprovals).toHaveBeenCalledTimes(1);
    });

    it('user changing the max screenshot edge pushes it to the driver', async () => {
        const wrapper = await mountPage();

        await wrapper.get('[data-testid="computer-use-max-image"]').setValue('2048');
        await flush();

        expect(saveSettings).toHaveBeenCalledWith({ maxImageDimension: 2048 });
        expect(applySettings).toHaveBeenCalled();
    });

    it('user given a newer driver when confirming the update then installs it and shows the new version', async () => {
        checkUpdate.mockResolvedValue({
            current: '0.38.0',
            error: null,
            latest: '0.39.0',
            updateAvailable: true,
        });
        installUpdate.mockResolvedValue({
            abiVersion: '1.1.0',
            binary: 'C:/data/computer-use/0.39.0/cua_driver_sdk.dll',
            driverVersion: '0.39.0',
            error: null,
            installed: true,
            installedSizeBytes: 33_000_000,
        });
        const wrapper = await mountPage();

        await wrapper.get('[data-testid="computer-use-check-update"]').trigger('click');
        await flush();

        expect(confirm).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('0.39.0'),
                title: expect.stringContaining('cua-driver'),
            })
        );
        expect(installUpdate).toHaveBeenCalledWith('cua-driver', '0.39.0');
        expect(state.alert.success).toHaveBeenCalledWith(
            t('settings.computerUse.update.installed', { version: '0.39.0' })
        );
        expect(wrapper.get('[data-testid="computer-use-driver-select"]').text()).toContain(
            'cua-driver'
        );
    });

    it('user given an update prompt when declining then keeps the installed version', async () => {
        checkUpdate.mockResolvedValue({
            current: '0.38.0',
            error: null,
            latest: '0.39.0',
            updateAvailable: true,
        });
        confirm.mockResolvedValueOnce(false);
        const wrapper = await mountPage();

        await wrapper.get('[data-testid="computer-use-check-update"]').trigger('click');
        await flush();

        expect(installUpdate).not.toHaveBeenCalled();
        expect(state.alert.success).not.toHaveBeenCalled();
    });

    it('user given an update in progress when checking then only that driver is busy', async () => {
        let resolveUpdate!: (value: unknown) => void;
        checkUpdate.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveUpdate = resolve;
            })
        );
        const wrapper = await mountPage();
        const updateAction = wrapper.get('[data-testid="computer-use-check-update"]');
        const otherDriver = wrapper.get('[role="group"][aria-label="agent-desktop"]');
        const otherAction = otherDriver.get('[data-testid="computer-use-check-update"]');

        await updateAction.trigger('click');

        expect(updateAction.attributes()).toHaveProperty('disabled');
        expect(updateAction.attributes('aria-busy')).toBe('true');
        expect(otherAction.attributes()).not.toHaveProperty('disabled');

        resolveUpdate({ current: '0.38.0', error: null, latest: '0.38.0', updateAvailable: false });
        await flush();
        expect(state.alert.success).toHaveBeenCalledWith(t('settings.computerUse.update.current'));
        expect(updateAction.attributes()).not.toHaveProperty('disabled');
        expect(updateAction.attributes('aria-busy')).toBe('false');
    });

    it('user given a failed update when installing then sees the error and can retry', async () => {
        checkUpdate.mockResolvedValue({
            current: '0.38.0',
            error: null,
            latest: '0.39.0',
            updateAvailable: true,
        });
        installUpdate.mockRejectedValueOnce(new Error('Update unavailable'));
        const wrapper = await mountPage();
        const updateAction = wrapper.get('[data-testid="computer-use-check-update"]');

        await updateAction.trigger('click');
        await flush();

        expect(state.alert.error).toHaveBeenCalledWith('Update unavailable');
        expect(updateAction.attributes()).not.toHaveProperty('disabled');
        expect(updateAction.attributes('aria-busy')).toBe('false');
    });

    it('user given a restored driver after a failed update then sees the previous version', async () => {
        checkUpdate.mockResolvedValue({
            current: '0.38.0',
            error: null,
            latest: '0.39.0',
            updateAvailable: true,
        });
        installUpdate.mockResolvedValue({
            abiVersion: '1.1.0',
            binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
            driverVersion: '0.38.0',
            error: null,
            installed: true,
            installedSizeBytes: 32_842_600,
        });
        const wrapper = await mountPage();

        await wrapper.get('[data-testid="computer-use-check-update"]').trigger('click');
        await flush();

        expect(state.alert.warning).toHaveBeenCalledWith(
            t('settings.computerUse.update.restored', { version: '0.38.0' })
        );
        expect(state.alert.success).not.toHaveBeenCalled();
    });

    it('user given computer control is off when viewing the driver then cannot update or remove it', async () => {
        state.isEnabled.mockResolvedValueOnce(false);
        const wrapper = await mountPage();
        for (const id of ['computer-use-check-update', 'computer-use-remove']) {
            expect(wrapper.get(`[data-testid="${id}"]`).attributes()).toHaveProperty('disabled');
        }
    });

    it('user removing the driver confirms first and refreshes the state', async () => {
        remove.mockImplementation(async () => {
            state.loadDriver.mockResolvedValue('agent-desktop');
        });
        const wrapper = await mountPage();
        status.mockResolvedValueOnce({
            installed: false,
            error: null,
            abiVersion: null,
            binary: null,
            driverVersion: null,
        });

        await wrapper.get('[data-testid="computer-use-remove"]').trigger('click');
        await flush();

        expect(confirm).toHaveBeenCalledWith(
            expect.objectContaining({
                title: expect.stringContaining('cua-driver'),
                message: expect.stringContaining('cua-driver'),
            })
        );
        expect(remove).toHaveBeenCalledTimes(1);
        expect(
            (wrapper.get('[data-testid="computer-use-driver-select"]').element as HTMLSelectElement)
                .value
        ).toBe('agent-desktop');
        expect(state.alert.success).toHaveBeenCalledWith(t('settings.computerUse.removed'));
    });

    it('user sees controls without statistics or driver internals when opening settings', async () => {
        const wrapper = await mountPage();

        expect(wrapper.find('[data-testid="computer-use-stats"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('ABI');
        expect(wrapper.text()).not.toContain('cua_driver_sdk.dll');
        expect(wrapper.find('[data-testid="computer-use-max-image"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="computer-use-recording-toggle"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="computer-use-advanced-toggle"]').exists()).toBe(false);
    });

    it('user given a ready driver when opening settings then sees its selector and driver actions', async () => {
        const wrapper = await mountPage();

        expect(wrapper.get('[data-testid="computer-use-driver-select"]').text()).toContain(
            'cua-driver'
        );
        expect(wrapper.find('[data-testid="computer-use-driver-actions"]').exists()).toBe(false);
        const menu = wrapper.get('[data-testid="computer-use-driver-options"]');
        for (const [id, label] of [
            ['computer-use-check-update', t('settings.computerUse.action.checkUpdate')],
            ['computer-use-remove', t('settings.computerUse.action.remove')],
        ]) {
            const action = menu.get(`[data-testid="${id}"]`);
            expect(action.element.tagName).toBe('BUTTON');
            expect(action.attributes('aria-label')).toBe(`${label} · cua-driver`);
            expect(action.text()).toBe('');
            expect(action.element.closest('[role="group"]')?.getAttribute('aria-label')).toBe(
                'cua-driver'
            );
        }
    });

    it('user given a removal confirmation when declining then keeps the installed driver', async () => {
        confirm.mockResolvedValueOnce(false);
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-remove"]').trigger('click');
        await flush();
        expect(remove).not.toHaveBeenCalled();
        expect(
            wrapper.get<HTMLSelectElement>('[data-testid="computer-use-driver-select"]').element
                .value
        ).toBe('cua-driver');
    });

    it('user given a driver failure when opening settings then sees the failure instead of a ready status', async () => {
        status.mockResolvedValue({
            abiVersion: null,
            binary: null,
            driverVersion: '0.38.0',
            error: 'Driver unavailable',
            installed: true,
        });
        const wrapper = await mountPage();

        expect(wrapper.find('[data-testid="computer-use-status"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-no-driver"]').exists()).toBe(false);
        expect(wrapper.text()).toContain('Driver unavailable');
    });
});
