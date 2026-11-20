import { posix } from 'node:path';

import { chooseSettingsOption, createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'vue-sonner';

import type {
    ComputerUseDriverId,
    ComputerUseSettings as Preferences,
} from '@/app/api/tools/computer';
import { setLocale, t } from '@/i18n';
import type { ComputerUseDriverStatus } from '@/platform/native/types';
import ComputerUseSettings from '@/views/SettingsView/components/ComputerUse/index.vue';

const { pick } = vi.hoisted(() => ({ pick: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: pick }));
vi.mock('@tauri-apps/api/path', () => ({
    join: async (...parts: string[]) => posix.join(...parts),
}));
let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
const wrappers: VueWrapper[] = [];
const available: ComputerUseDriverStatus = {
    installed: true,
    error: null,
    abi_version: '1.1.0',
    binary: 'C:/private/driver.dll',
    driver_version: '0.38.0',
};
let statuses: Record<ComputerUseDriverId, typeof available>;
let location = '';
let recording: { enabled: boolean; outputDir?: string };
let blockWrite: ((key: string, value: string) => Promise<void> | void) | undefined;

beforeEach(async () => {
    toast.dismiss();
    await flushPromises();
    setLocale('en-US');
    pick.mockReset();
    location = '';
    blockWrite = undefined;
    recording = { enabled: false };
    statuses = {
        'cua-driver': { ...available },
        'agent-desktop': { ...available, driver_version: '1.2.0' },
    };
    fixture = await createSettingsPanelFixture({
        query: {
            beforeQuery({ sql, params }) {
                if (/insert into "settings"/i.test(sql))
                    return blockWrite?.(String(params[0]), String(params[1]));
            },
        },
    });
    fixture.database
        .prepare("UPDATE built_in_tools SET enabled = 1 WHERE tool_id = 'computer_use'")
        .run();
    fixture.database
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('computer_use.group.clipboard', 'false');
    mockTauriCommand('get_app_directory_path', 'C:/cache');
    mockTauriCommand('computer_use_driver_directory', () => location);
    mockTauriCommand(
        'computer_use_set_driver_directory',
        (payload) => (location = (payload as { directory: string }).directory)
    );
    mockTauriCommand(
        'computer_use_status',
        (payload) => statuses[(payload as { driver: ComputerUseDriverId }).driver]
    );
    mockTauriCommand('computer_use_prepare', (payload) => {
        const driver = (payload as { driver: ComputerUseDriverId }).driver;
        statuses[driver] = { ...available };
        return statuses[driver];
    });
    mockTauriCommand('computer_use_invoke', { content: [] });
    mockTauriCommand('computer_use_set_recording', (payload) => {
        recording = payload as typeof recording;
        return true;
    });
    mockTauriCommand('computer_use_check_update', {
        current: '0.38.0',
        latest: '0.38.0',
        update_available: false,
        error: null,
    });
    mockTauriCommand('computer_use_install_update', (payload) => ({
        ...available,
        driver_version: (payload as { version: string }).version,
    }));
    mockTauriCommand('computer_use_remove', (payload) => {
        statuses[(payload as { driver: ComputerUseDriverId }).driver] = {
            ...available,
            installed: false,
        };
        return true;
    });
});
afterEach(async () => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    await fixture.dispose();
    vi.useRealTimers();
});
async function mountPage() {
    const wrapper = mount(ComputerUseSettings, fixture.viewOptions);
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}
async function menu(wrapper: VueWrapper) {
    const trigger = wrapper.get('[data-testid="computer-use-driver-select"]');
    if (trigger.attributes('aria-expanded') !== 'true') {
        await trigger.trigger('keydown', { key: 'Enter' });
        await flushPromises();
    }
}
function action(id: string, driver: ComputerUseDriverId = 'cua-driver'): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(
        `[role="group"][aria-label="${driver}"] [data-testid="computer-use-${id}"]`
    );
    if (!button) throw new Error(`Missing action ${id} for ${driver}`);
    return button;
}
async function clickAction(wrapper: VueWrapper, id: string, driver?: ComputerUseDriverId) {
    await menu(wrapper);
    action(id, driver).click();
    await flushPromises();
}
async function confirmDialog(accept: boolean) {
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    const label = accept ? t('common.confirm') : t('common.cancel');
    const button = [...dialog!.querySelectorAll('button')].find(
        (item) =>
            item.textContent?.trim() === label ||
            (accept && item.textContent?.trim() === t('settings.computerUse.update.confirmAction'))
    );
    expect(button).toBeDefined();
    button!.click();
    await flushPromises();
}
async function settings(): Promise<Preferences> {
    return fixture.client.computer.loadSettings();
}
function setSaved(value: Partial<Preferences>) {
    return fixture.client.computer.saveSettings(value);
}
function assertError() {
    expect(document.body.textContent).toContain('COMPUTER_COMMAND_FAILED');
}

describe('given actual computer settings controls connected to the production main Tools owner', () => {
    it('user given a directory picker when closing the panel then a late selection cannot move driver storage', async () => {
        let finish!: (value: string) => void;
        pick.mockImplementation(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                })
        );
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-driver-directory-pick"]').trigger('click');
        wrapper.unmount();
        finish('D:/late');
        await flushPromises();
        expect(getTauriInvokeCalls('computer_use_set_driver_directory')).toEqual([]);
        expect(location).toBe('');
    });

    it('user given a pending driver download when closing the panel then its result cannot start runtime configuration', async () => {
        statuses['cua-driver'].installed = false;
        let finish!: (value: typeof available) => void;
        mockTauriCommand(
            'computer_use_prepare',
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const wrapper = await mountPage();
        await clickAction(wrapper, 'install');
        wrapper.unmount();
        finish(available);
        await flushPromises();
        expect(getTauriInvokeCalls('computer_use_invoke')).toEqual([]);
        expect(getTauriInvokeCalls('computer_use_set_recording')).toEqual([]);
    });
    it.each(['zh-CN', 'en-US'] as const)(
        'user given %s preferences when opening then sees basic and permission controls without driver internals',
        async (locale) => {
            setLocale(locale);
            const wrapper = await mountPage();
            expect(wrapper.get('h1').text()).toBe(t('settings.nav.computerUse.label'));
            expect(wrapper.get('header p').text()).toBe(t('settings.nav.computerUse.description'));
            expect(wrapper.findAll('h2').map((node) => node.text())).toEqual([
                t('settings.computerUse.group.basic'),
                t('settings.computerUse.group.permission'),
            ]);
            expect(wrapper.text()).not.toContain('ABI');
            expect(wrapper.text()).not.toContain('driver.dll');
            expect(wrapper.find('[data-testid="computer-use-stats"]').exists()).toBe(false);
            expect(wrapper.findAll('[data-testid^="computer-use-group-"]')).toHaveLength(8);
        }
    );
    it('user given default driver storage when opening then sees an empty location without an internal path', async () => {
        const wrapper = await mountPage();
        const input = wrapper.get<HTMLInputElement>(
            '[data-testid="computer-use-driver-directory"]'
        );
        expect(input.element.value).toBe('');
        expect(input.attributes('placeholder')).toBe(
            t('settings.computerUse.driverDirectory.default')
        );
        expect(wrapper.find('[data-testid="computer-use-driver-directory-reset"]').exists()).toBe(
            false
        );
    });
    it('user given a custom location when restoring default then retains the empty location after reopening', async () => {
        location = 'D:/drivers';
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-driver-directory-reset"]').trigger('click');
        await flushPromises();
        expect(location).toBe('');
        wrapper.unmount();
        expect(
            (await mountPage()).get<HTMLInputElement>(
                '[data-testid="computer-use-driver-directory"]'
            ).element.value
        ).toBe('');
    });
    it('user given a failed storage reset when restoring default then keeps the old path and can retry', async () => {
        location = 'D:/drivers';
        mockTauriCommand('computer_use_set_driver_directory', () => {
            throw new Error('private failure');
        });
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-driver-directory-reset"]').trigger('click');
        await flushPromises();
        assertError();
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
    it('user given no installed drivers when picking a storage location then sees the saved path after reopening', async () => {
        statuses['cua-driver'].installed = false;
        statuses['agent-desktop'].installed = false;
        pick.mockResolvedValue('D:/drivers');
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-driver-directory-pick"]').trigger('click');
        await flushPromises();
        expect(location).toBe('D:/drivers');
        wrapper.unmount();
        expect(
            (await mountPage()).get<HTMLInputElement>(
                '[data-testid="computer-use-driver-directory"]'
            ).element.value
        ).toBe('D:/drivers');
    });
    it('user given a location picker when cancelling then keeps the current directory', async () => {
        pick.mockResolvedValue(null);
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-driver-directory-pick"]').trigger('click');
        await flushPromises();
        expect(location).toBe('');
        expect(getTauriInvokeCalls('computer_use_set_driver_directory')).toEqual([]);
    });
    it('user given installed and missing drivers when opening their list then sees measured size only for the installed driver', async () => {
        statuses['cua-driver'] = {
            ...available,
            installed_size_bytes: 32_842_600,
        } as typeof available;
        statuses['agent-desktop'].installed = false;
        const wrapper = await mountPage();
        await menu(wrapper);
        expect(
            document.querySelector('[role="group"][aria-label="cua-driver"]')!.textContent
        ).toContain('32.8 MB');
        expect(
            document.querySelector('[role="group"][aria-label="agent-desktop"]')!.textContent
        ).not.toContain('MB');
    });
    it('user given unknown installed sizes when opening the list then sees no invented number', async () => {
        const wrapper = await mountPage();
        await menu(wrapper);
        expect(
            document.querySelector('[data-testid="computer-use-driver-options"]')!.textContent
        ).not.toContain('MB');
    });
    it.each(['computer-use-foreground-toggle', 'computer-use-cursor-toggle'])(
        'user given a pending %s write when changing another preference then only the pending control is disabled and both values commit',
        async (id) => {
            let release!: () => void;
            blockWrite = (key) =>
                key === 'computer_use.settings'
                    ? new Promise<void>((resolve) => {
                          release = resolve;
                      })
                    : undefined;
            const wrapper = await mountPage();
            await wrapper.get(`[data-testid="${id}"]`).trigger('click');
            await flushPromises();
            expect(wrapper.get(`[data-testid="${id}"]`).element.matches(':disabled')).toBe(true);
            expect(
                wrapper
                    .get('[data-testid="computer-use-group-clipboard"]')
                    .element.matches(':disabled')
            ).toBe(false);
            await wrapper.get('[data-testid="computer-use-group-clipboard"]').trigger('click');
            await flushPromises();
            expect((await fixture.client.computer.loadGroups()).clipboard).toBe(true);
            blockWrite = undefined;
            release();
            await flushPromises();
            expect(wrapper.get(`[data-testid="${id}"]`).attributes('aria-checked')).toBe('false');
        }
    );
    it('user given overlapping preference writes when saving then both choices remain visible and persisted', async () => {
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-foreground-toggle"]').trigger('click');
        await wrapper.get('[data-testid="computer-use-cursor-toggle"]').trigger('click');
        await flushPromises();
        expect(await settings()).toMatchObject({ allowForeground: false, cursorVisible: false });
        expect(
            wrapper.get('[data-testid="computer-use-foreground-toggle"]').attributes('aria-checked')
        ).toBe('false');
        expect(
            wrapper.get('[data-testid="computer-use-cursor-toggle"]').attributes('aria-checked')
        ).toBe('false');
    });
    it('user given an enabled master switch when disabling then saves it and disables preferences without changing groups', async () => {
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-enabled-toggle"]').trigger('click');
        await flushPromises();
        expect(await fixture.client.computer.isEnabled()).toBe(false);
        expect(wrapper.get('fieldset').attributes()).toHaveProperty('disabled');
        expect((await fixture.client.computer.loadGroups()).clipboard).toBe(false);
    });
    it('user given a disabled clipboard group when enabling then persists that group without changing the others', async () => {
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-group-clipboard"]').trigger('click');
        await flushPromises();
        expect(await fixture.client.computer.loadGroups()).toMatchObject({
            clipboard: true,
            input: true,
            runtime: true,
        });
    });
    it.each(['session-window', 'full-access'] as const)(
        'user given approval choices when selecting %s then persists the chosen existing policy',
        async (label) => {
            const wrapper = await mountPage();
            await chooseSettingsOption(
                wrapper.get('[data-testid="computer-use-approval-mode"]'),
                t(
                    label === 'full-access'
                        ? 'settings.computerUse.approval.fullAccess'
                        : 'settings.computerUse.approval.session'
                )
            );
            expect((await settings()).approval).toBe(label);
        }
    );
    it('user given screenshot choices when choosing a larger edge then persists and applies it to the driver', async () => {
        const wrapper = await mountPage();
        await chooseSettingsOption(
            wrapper.get('[data-testid="computer-use-max-image"]'),
            t('settings.computerUse.screenshot.sharp')
        );
        expect((await settings()).maxImageDimension).toBe(2048);
        expect(
            getTauriInvokeCalls('computer_use_invoke').some((call) =>
                JSON.stringify(call.payload).includes('2048')
            )
        ).toBe(true);
    });
    it('user given recording off when enabling and disabling then sees the saved location only while enabled', async () => {
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-recording-toggle"]').trigger('click');
        await flushPromises();
        expect(recording.enabled).toBe(true);
        expect((await settings()).recordingEnabled).toBe(true);
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-recording-directory"]')
                .element.value
        ).toContain('cua-driver');
        await wrapper.get('[data-testid="computer-use-recording-toggle"]').trigger('click');
        await flushPromises();
        expect(recording.enabled).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-recording-directory"]').exists()).toBe(
            false
        );
    });
    it('user given recording enabled when selecting a folder then retains its driver-specific location after reopening', async () => {
        await setSaved({ recordingEnabled: true });
        pick.mockResolvedValue('C:/records');
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-recording-directory-pick"]').trigger('click');
        await flushPromises();
        expect(recording.outputDir).toBe('C:/records/cua-driver');
        wrapper.unmount();
        expect(
            (await mountPage()).get<HTMLInputElement>(
                '[data-testid="computer-use-recording-directory"]'
            ).element.value
        ).toBe('C:/records/cua-driver');
    });
    it('user given an unwritable recording folder when selecting then retains the previous location and can retry', async () => {
        await setSaved({ recordingEnabled: true });
        await fixture.client.computer.saveRecordingDirectory('C:/previous');
        pick.mockResolvedValue('C:/unwritable');
        mockTauriCommand('computer_use_set_recording', () => {
            throw new Error('private failure');
        });
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-recording-directory-pick"]').trigger('click');
        await flushPromises();
        assertError();
        expect(await fixture.client.computer.loadRecordingDirectory()).toBe(
            'C:/previous/cua-driver'
        );
        expect(
            wrapper
                .get('[data-testid="computer-use-recording-directory-pick"]')
                .element.matches(':disabled')
        ).toBe(false);
    });
    it('user given a failed recorder start when enabling then retains the disabled setting and hides its location', async () => {
        mockTauriCommand('computer_use_set_recording', () => {
            throw new Error('private failure');
        });
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="computer-use-recording-toggle"]').trigger('click');
        await flushPromises();
        assertError();
        expect((await settings()).recordingEnabled).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-recording-directory"]').exists()).toBe(
            false
        );
    });
    it('user given a missing driver when opening then keeps preferences visible but disabled and can download it', async () => {
        statuses['cua-driver'].installed = false;
        statuses['agent-desktop'].installed = false;
        const wrapper = await mountPage();
        await menu(wrapper);
        expect(
            wrapper
                .get('[data-testid="computer-use-recording-toggle"]')
                .element.matches(':disabled')
        ).toBe(true);
        expect(action('install').disabled).toBe(false);
        expect(action('install', 'agent-desktop').disabled).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-no-driver"]').exists()).toBe(false);
    });
    it('user given a missing driver when downloading then sees progress and cannot start it twice', async () => {
        statuses['cua-driver'].installed = false;
        let finish!: (value: typeof available) => void;
        mockTauriCommand(
            'computer_use_prepare',
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const wrapper = await mountPage();
        await clickAction(wrapper, 'install');
        const button = action('install');
        button.click();
        await flushPromises();
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(button.disabled).toBe(true);
        expect(getTauriInvokeCalls('computer_use_prepare')).toHaveLength(1);
        finish(available);
        await flushPromises();
        expect(
            document.querySelector(
                '[role="group"][aria-label="cua-driver"] [data-testid="computer-use-install"]'
            )
        ).toBeNull();
        expect(document.body.textContent).toContain('v0.38.0');
    });
    it.each(['rejected', 'reported'])(
        'user given a %s download failure when it settles then sees the failure and can retry',
        async (failure) => {
            statuses['cua-driver'].installed = false;
            mockTauriCommand('computer_use_prepare', () => {
                if (failure === 'rejected') throw new Error('private failure');
                return { ...available, installed: false, error: 'Download unavailable' };
            });
            const wrapper = await mountPage();
            await clickAction(wrapper, 'install');
            expect(action('install').disabled).toBe(false);
            expect(action('install').getAttribute('aria-busy')).toBe('false');
            if (failure === 'rejected') assertError();
            else expect(document.body.textContent).toContain('Download unavailable');
            mockTauriCommand('computer_use_prepare', available);
            action('install').click();
            await flushPromises();
            expect(document.body.textContent).toContain('v0.38.0');
        }
    );
    it('user given two installed drivers when switching then sees only the selected driver supported preferences', async () => {
        await setSaved({ recordingEnabled: true, approval: 'session-window' });
        const wrapper = await mountPage();
        await chooseSettingsOption(
            wrapper.get('[data-testid="computer-use-driver-select"]'),
            'agent-desktop'
        );
        expect(await fixture.client.computer.loadDriver()).toBe('agent-desktop');
        expect(wrapper.find('[data-testid="computer-use-max-image"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-group-browser"]').exists()).toBe(false);
        expect(
            wrapper.get<HTMLInputElement>('[data-testid="computer-use-recording-directory"]')
                .element.value
        ).toContain('agent-desktop');
        await chooseSettingsOption(
            wrapper.get('[data-testid="computer-use-driver-select"]'),
            'cua-driver'
        );
        expect(wrapper.find('[data-testid="computer-use-max-image"]').exists()).toBe(true);
    });
    it('user given a missing alternate driver when choosing then keeps the active driver and can download the alternate', async () => {
        statuses['agent-desktop'].installed = false;
        const wrapper = await mountPage();
        await menu(wrapper);
        const option = document.querySelector(
            '[role="group"][aria-label="agent-desktop"] [role="option"]'
        )!;
        expect(option.getAttribute('aria-disabled')).toBe('true');
        option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await flushPromises();
        expect(await fixture.client.computer.loadDriver()).toBe('cua-driver');
        expect(action('install', 'agent-desktop').disabled).toBe(false);
    });
    it('user given two driver choices when checking the second then keeps the active driver', async () => {
        const wrapper = await mountPage();
        await clickAction(wrapper, 'check-update', 'agent-desktop');
        expect(getTauriInvokeCalls('computer_use_check_update').at(-1)!.payload).toEqual({
            driver: 'agent-desktop',
        });
        expect(await fixture.client.computer.loadDriver()).toBe('cua-driver');
    });
    it('user given a newer driver when confirming then installs it and shows the new version', async () => {
        mockTauriCommand('computer_use_check_update', {
            current: '0.38.0',
            latest: '0.39.0',
            update_available: true,
            error: null,
        });
        const wrapper = await mountPage();
        await clickAction(wrapper, 'check-update');
        expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('0.39.0');
        await confirmDialog(true);
        expect(getTauriInvokeCalls('computer_use_install_update').at(-1)!.payload).toEqual({
            driver: 'cua-driver',
            version: '0.39.0',
        });
        expect(document.body.textContent).toContain('0.39.0');
    });
    it('user given an update prompt when declining then keeps the installed version', async () => {
        mockTauriCommand('computer_use_check_update', {
            current: '0.38.0',
            latest: '0.39.0',
            update_available: true,
            error: null,
        });
        const wrapper = await mountPage();
        await clickAction(wrapper, 'check-update');
        await confirmDialog(false);
        expect(getTauriInvokeCalls('computer_use_install_update')).toEqual([]);
    });
    it('user given a pending update check when waiting then only that driver is busy and recovers after failure', async () => {
        let reject!: (error: Error) => void;
        mockTauriCommand(
            'computer_use_check_update',
            () =>
                new Promise((_resolve, failure) => {
                    reject = failure;
                })
        );
        const wrapper = await mountPage();
        await clickAction(wrapper, 'check-update');
        expect(action('check-update').disabled).toBe(true);
        expect(action('check-update', 'agent-desktop').disabled).toBe(false);
        reject(new Error('private failure'));
        await flushPromises();
        assertError();
        expect(action('check-update').disabled).toBe(false);
    });
    it('user given a restored driver after a failed installation when updating then sees its previous version and a warning', async () => {
        mockTauriCommand('computer_use_check_update', {
            current: '0.38.0',
            latest: '0.39.0',
            update_available: true,
            error: null,
        });
        mockTauriCommand('computer_use_install_update', available);
        const wrapper = await mountPage();
        await clickAction(wrapper, 'check-update');
        await confirmDialog(true);
        expect(document.body.textContent).toContain(
            t('settings.computerUse.update.restored', { version: '0.38.0' })
        );
    });
    it('user given computer control off when viewing drivers then cannot update or remove them', async () => {
        await fixture.client.computer.setEnabled(false);
        const wrapper = await mountPage();
        expect(
            wrapper.get('[data-testid="computer-use-driver-select"]').element.matches(':disabled')
        ).toBe(true);
        expect(getTauriInvokeCalls('computer_use_check_update')).toEqual([]);
        expect(getTauriInvokeCalls('computer_use_remove')).toEqual([]);
    });
    it('user given a removal prompt when declining then keeps the installed driver', async () => {
        const wrapper = await mountPage();
        await clickAction(wrapper, 'remove');
        await confirmDialog(false);
        expect(getTauriInvokeCalls('computer_use_remove')).toEqual([]);
        expect(await fixture.client.computer.loadDriver()).toBe('cua-driver');
    });
    it('user given a confirmed removal when deleting then refreshes and selects the remaining installed driver', async () => {
        const wrapper = await mountPage();
        await clickAction(wrapper, 'remove');
        await confirmDialog(true);
        expect(await fixture.client.computer.loadDriver()).toBe('agent-desktop');
        expect(wrapper.get('[data-testid="computer-use-driver-select"]').text()).toContain(
            'agent-desktop'
        );
    });
    it('user given the last installed driver when removing then keeps preferences visible and disabled', async () => {
        statuses['agent-desktop'].installed = false;
        const wrapper = await mountPage();
        await clickAction(wrapper, 'remove');
        await confirmDialog(true);
        expect(
            wrapper
                .get('[data-testid="computer-use-recording-toggle"]')
                .element.matches(':disabled')
        ).toBe(true);
        expect(wrapper.find('[data-testid="computer-use-no-driver"]').exists()).toBe(false);
    });
    it('user given a driver failure when opening then sees its failure without a false ready status', async () => {
        statuses['cua-driver'].error = 'Driver unavailable';
        const wrapper = await mountPage();
        await menu(wrapper);
        expect(document.body.textContent).toContain('Driver unavailable');
        expect(wrapper.find('[data-testid="computer-use-status"]').exists()).toBe(false);
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
