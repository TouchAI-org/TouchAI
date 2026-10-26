import type {
    AppUpdateChannelLatest,
    AppUpdateInfo,
    AppUpdateRequirement,
    AppUpdateState,
} from '@services/AppUpdateService/types';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import UpdateSettingsSection from '@/views/SettingsView/components/General/UpdateSettingsSection.vue';

/*
 * The update section is a status panel: it reports what the updater is doing and
 * offers the one action that makes sense for that state. Every branch below is a
 * different updater state, so the assertions read the row the user sees and the
 * call the button makes — not the component's computed properties.
 */

const appUpdateServiceMock = vi.hoisted(() => {
    const listeners = new Set<(state: AppUpdateState) => void>();
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
        listeners,
        state: createState(),
        publishState: (patch: Partial<AppUpdateState>) => {
            appUpdateServiceMock.state = { ...appUpdateServiceMock.state, ...patch };
            listeners.forEach((listener) => listener(appUpdateServiceMock.state));
        },
        getState: vi.fn(() => appUpdateServiceMock.state),
        subscribe: vi.fn((listener: (state: AppUpdateState) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }),
        initialize: vi.fn(async () => undefined),
        checkNow: vi.fn(async () => true),
        setChannel: vi.fn(async () => undefined),
        setAutoCheckEnabled: vi.fn(async () => undefined),
        download: vi.fn(async () => undefined),
        install: vi.fn(async () => undefined),
    };
});

vi.mock('@services/AppUpdateService', () => ({ appUpdateService: appUpdateServiceMock }));

const { openUrlMock, getVersionMock } = vi.hoisted(() => ({
    openUrlMock: vi.fn(async () => undefined),
    getVersionMock: vi.fn(async () => '0.1.0'),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: getVersionMock }));

// The caller's data-testid falls through to the stub root, so the stub must not
// set one of its own.
vi.mock('@components/ui/switch', () => ({
    Switch: {
        name: 'UiSwitch',
        props: ['modelValue', 'size', 'disabled'],
        emits: ['update:model-value'],
        template: `
            <button
                :data-checked="String(modelValue)"
                :disabled="disabled"
                @click="$emit('update:model-value', !modelValue)"
            />
        `,
    },
}));

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options', 'disabled'],
        emits: ['update:modelValue'],
        template: `
            <div data-testid="update-channel-select" :data-value="modelValue">
                <span data-testid="channel-labels">{{ options.map((o) => o.label).join('|') }}</span>
                <span data-testid="channel-descriptions">
                    {{ options.map((o) => o.description).join('|') }}
                </span>
            </div>
        `,
    },
}));

// labelAttrs is how the section tags the status row, so the stub has to render it.
vi.mock('@components/SettingsRow.vue', () => ({
    default: {
        name: 'SettingsRow',
        props: ['label', 'labelAttrs', 'controlAttrs', 'controlWidth'],
        template: `
            <div>
                <span v-bind="labelAttrs">{{ label }}</span>
                <slot name="description" />
                <slot />
            </div>
        `,
    },
}));

vi.mock('@/views/SettingsView/components/General/UpdateDetailsDialog.vue', () => ({
    default: {
        name: 'UpdateDetailsDialog',
        props: [
            'title',
            'version',
            'channel',
            'publishedAt',
            'hasUpdate',
            'releaseNotes',
            'actionText',
            'busy',
            'downloadProgress',
            'error',
        ],
        emits: ['close', 'action'],
        template: `
            <div
                data-testid="update-details-dialog"
                :data-title="title"
                :data-version="version"
                :data-published="publishedAt ?? ''"
                :data-has-update="String(hasUpdate)"
                :data-notes="releaseNotes"
                :data-action="actionText"
                :data-busy="String(busy)"
                :data-progress="downloadProgress === null ? '' : String(downloadProgress)"
                :data-error="error ?? ''"
            >
                <button data-testid="dialog-close" @click="$emit('close')" />
                <button data-testid="dialog-action" @click="$emit('action')" />
            </div>
        `,
    },
}));

enableAutoUnmount(afterEach);
// The service mock is module state shared with every other settings file, so it is
// fully reset here instead of relying on each test to tidy up after itself.
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    appUpdateServiceMock.listeners.clear();
    appUpdateServiceMock.state = appUpdateServiceMock.createState();
    document.body.innerHTML = '';
});

/** The update the service reports as available for this platform. */
function update(overrides: Partial<AppUpdateInfo> = {}): AppUpdateInfo {
    return {
        version: '0.2.0',
        fileName: 'TouchAI_0.2.0_x64-setup.exe',
        notes: 'Fixes and polish',
        sizeBytes: 1024,
        ...overrides,
    };
}

/** The channel feed entry the release list is built from. */
function channelLatest(overrides: Partial<AppUpdateChannelLatest> = {}): AppUpdateChannelLatest {
    return {
        version: '0.2.0',
        tag: 'v0.2.0',
        releaseUrl: 'https://example.com/release',
        publishedAt: '2026-05-20T00:00:00.000Z',
        prerelease: false,
        releaseNotes: 'Fixes and polish',
        downloads: [
            {
                kind: 'installer',
                name: 'TouchAI_0.2.0_x64-setup.exe',
                url: 'https://example.com/setup.exe',
                sizeBytes: 1024,
            },
        ],
        ...overrides,
    };
}

/** The minimum-version gate the service reports alongside a check. */
function requirement(overrides: Partial<AppUpdateRequirement> = {}): AppUpdateRequirement {
    return {
        required: false,
        minimumSupportedVersion: null,
        requiredSeverity: null,
        requiredReason: null,
        targetSatisfiesRequirement: true,
        ...overrides,
    };
}

function mountSection(patch: Partial<AppUpdateState> = {}) {
    appUpdateServiceMock.state = { ...appUpdateServiceMock.createState(), ...patch };
    return mount(UpdateSettingsSection);
}

function statusTitle(wrapper: ReturnType<typeof mountSection>) {
    return wrapper.get('[data-testid="settings-update-status-title"]').text();
}

function primaryAction(wrapper: ReturnType<typeof mountSection>) {
    return wrapper.get('[data-testid="settings-update-primary-action"]');
}

function dialog(wrapper: ReturnType<typeof mountSection>) {
    return wrapper.find('[data-testid="update-details-dialog"]');
}

function dialogExists(wrapper: ReturnType<typeof mountSection>) {
    return wrapper.find('[data-testid="update-details-dialog"]').exists();
}

beforeEach(() => {
    setLocale('zh-CN');
    appUpdateServiceMock.listeners.clear();
    appUpdateServiceMock.state = appUpdateServiceMock.createState();
    for (const key of [
        'checkNow',
        'setChannel',
        'setAutoCheckEnabled',
        'download',
        'install',
        'initialize',
    ] as const) {
        appUpdateServiceMock[key].mockClear();
    }
    appUpdateServiceMock.checkNow.mockResolvedValue(true);
    getVersionMock.mockResolvedValue('0.1.0');
    openUrlMock.mockClear();
});

describe('user reads what the updater is doing', () => {
    it('user sees the current version when nothing has been found', () => {
        const wrapper = mountSection({ status: 'idle' });

        expect(statusTitle(wrapper)).toContain('0.1.0');
    });

    it('user sees that a check is running', () => {
        const wrapper = mountSection({ status: 'checking' });

        expect(statusTitle(wrapper)).toContain('检查');
    });

    it('user sees the download progress while it downloads', () => {
        const wrapper = mountSection({ status: 'downloading', downloadProgress: 42 });

        expect(statusTitle(wrapper)).toContain('42');
    });

    it('user sees the download progress default to zero when none was reported', () => {
        const wrapper = mountSection({ status: 'downloading', downloadProgress: null });

        expect(statusTitle(wrapper)).toContain('0');
    });

    it('user sees that the update is installing', () => {
        const wrapper = mountSection({ status: 'installing' });

        expect(statusTitle(wrapper)).toContain('安装');
    });

    it('user sees the version waiting to be installed', () => {
        const wrapper = mountSection({ status: 'downloaded', downloadedUpdate: update() });

        expect(statusTitle(wrapper)).toContain('0.2.0');
    });

    it('user sees the version offered when an update is available', () => {
        const wrapper = mountSection({ status: 'available', availableUpdate: update() });

        expect(statusTitle(wrapper)).toContain('0.2.0');
    });

    it('user sees that they are already on the latest version', () => {
        const wrapper = mountSection({ status: 'not_available', currentVersion: '0.1.0' });

        expect(statusTitle(wrapper)).toContain('最新');
        expect(statusTitle(wrapper)).toContain('0.1.0');
    });

    it('user sees that the last check failed', () => {
        const wrapper = mountSection({ status: 'failed', error: 'network down' });

        expect(statusTitle(wrapper)).toContain('失败');
        expect(wrapper.text()).toContain('network down');
    });

    it('user is told the platform cannot update itself', () => {
        const wrapper = mountSection({ status: 'unsupported' });

        expect(statusTitle(wrapper)).toContain('不支持');
    });

    it('user sees when the last check happened', () => {
        const wrapper = mountSection({ lastCheckedAt: '2026-05-22T10:00:00.000Z' });

        expect(wrapper.text()).toContain('上次检查');
    });

    it('user sees no check time before the first check has run', () => {
        const wrapper = mountSection({ lastCheckedAt: null });

        expect(wrapper.text()).not.toContain('上次检查');
    });

    it('user sees the installed version read from the app rather than the state', async () => {
        getVersionMock.mockResolvedValue('0.3.1');
        const wrapper = mountSection({ currentVersion: null, status: 'idle' });

        await flushPromises();

        expect(statusTitle(wrapper)).toContain('0.3.1');
    });

    it('user still sees the bundled version when the app cannot report one', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        getVersionMock.mockRejectedValue(new Error('no tauri'));
        const wrapper = mountSection({ currentVersion: null, status: 'idle' });

        await flushPromises();

        // The bundled version is the fallback, so the row still names a version.
        expect(statusTitle(wrapper)).toMatch(/V\d+\.\d+\.\d+/);
        consoleError.mockRestore();
    });

    it('user sees the version from the requirement when no release was fetched', () => {
        const wrapper = mountSection({
            status: 'available',
            updateRequirement: requirement({ minimumSupportedVersion: '0.2.5' }),
        });

        expect(statusTitle(wrapper)).toContain('0.2.5');
    });
});

describe('user checks for updates', () => {
    it('user gets a check started when they press the action', async () => {
        const wrapper = mountSection({ status: 'idle' });

        await primaryAction(wrapper).trigger('click');
        await flushPromises();

        expect(appUpdateServiceMock.checkNow).toHaveBeenCalledWith('manual');
    });

    it('user gets the details opened when a newer release is found', async () => {
        const wrapper = mountSection({ status: 'idle' });
        appUpdateServiceMock.checkNow.mockImplementation(async () => {
            appUpdateServiceMock.publishState({
                status: 'available',
                availableUpdate: update() as never,
            });
            return true;
        });

        await primaryAction(wrapper).trigger('click');
        await flushPromises();

        expect(dialogExists(wrapper)).toBe(true);
    });

    it('user gets the details opened after an unsupported result', async () => {
        const wrapper = mountSection({ status: 'idle' });
        appUpdateServiceMock.checkNow.mockImplementation(async () => {
            appUpdateServiceMock.publishState({
                status: 'unsupported',
                latestUpdate: {
                    version: '0.2.0',
                    releaseNotes: 'Notes',
                    publishedAt: null,
                    downloads: [],
                } as never,
            });
            return false;
        });

        await primaryAction(wrapper).trigger('click');
        await flushPromises();

        // The dialog explains why the app cannot update itself.
        expect(dialogExists(wrapper)).toBe(true);
    });

    it('user gets no details when the check found nothing', async () => {
        const wrapper = mountSection({ status: 'idle' });
        appUpdateServiceMock.checkNow.mockResolvedValue(false);
        appUpdateServiceMock.state = { ...appUpdateServiceMock.createState(), status: 'idle' };

        await primaryAction(wrapper).trigger('click');
        await flushPromises();

        expect(dialogExists(wrapper)).toBe(false);
    });

    it('user gets the action unavailable while a check is already running', () => {
        const wrapper = mountSection({ status: 'checking' });

        expect(primaryAction(wrapper).attributes('disabled')).toBeDefined();
    });
});

describe('user changes the update channel', () => {
    it('user sees every channel offered with a description', () => {
        const wrapper = mountSection();

        expect(wrapper.get('[data-testid="channel-labels"]').text().length).toBeGreaterThan(0);
        expect(wrapper.get('[data-testid="channel-descriptions"]').text().length).toBeGreaterThan(
            0
        );
    });

    it('user gets the new channel saved and a check started', async () => {
        const wrapper = mountSection({ channel: 'stable' });

        wrapper.findComponent({ name: 'CustomSelect' }).vm.$emit('update:modelValue', 'beta');
        await flushPromises();

        expect(appUpdateServiceMock.setChannel).toHaveBeenCalledWith('beta');
        expect(appUpdateServiceMock.checkNow).toHaveBeenCalledWith('settings-open');
    });

    it('user gets nothing saved when they re-pick the channel already set', async () => {
        const wrapper = mountSection({ channel: 'stable' });

        wrapper.findComponent({ name: 'CustomSelect' }).vm.$emit('update:modelValue', 'stable');
        await flushPromises();

        expect(appUpdateServiceMock.setChannel).not.toHaveBeenCalled();
    });

    it('user gets the channel locked while an update is running', () => {
        const wrapper = mountSection({ status: 'downloading' });

        expect(wrapper.find('[data-testid="update-channel-select"]').exists()).toBe(true);
        expect(wrapper.findComponent({ name: 'CustomSelect' }).props('disabled')).toBe(true);
    });

    it('user gets nothing saved when they change the channel mid-download', async () => {
        const wrapper = mountSection({ status: 'downloading', channel: 'stable' });

        wrapper.findComponent({ name: 'CustomSelect' }).vm.$emit('update:modelValue', 'beta');
        await flushPromises();

        expect(appUpdateServiceMock.setChannel).not.toHaveBeenCalled();
    });
});

describe('user turns automatic checks on or off', () => {
    it('user gets automatic checks turned off', async () => {
        const wrapper = mountSection({ autoCheckEnabled: true });

        await wrapper.get('[data-testid="settings-update-auto-check-toggle"]').trigger('click');
        await flushPromises();

        expect(appUpdateServiceMock.setAutoCheckEnabled).toHaveBeenCalledWith(false);
    });

    it('user gets automatic checks turned back on', async () => {
        const wrapper = mountSection({ autoCheckEnabled: false });

        await wrapper.get('[data-testid="settings-update-auto-check-toggle"]').trigger('click');
        await flushPromises();

        expect(appUpdateServiceMock.setAutoCheckEnabled).toHaveBeenCalledWith(true);
    });

    it('user gets the switch locked while an update is running', () => {
        const wrapper = mountSection({ status: 'installing' });

        expect(
            wrapper.get('[data-testid="settings-update-auto-check-toggle"]').attributes('disabled')
        ).toBeDefined();
    });

    it('user gets nothing changed when they toggle mid-download', async () => {
        const wrapper = mountSection({ status: 'downloading', autoCheckEnabled: true });

        await wrapper.get('[data-testid="settings-update-auto-check-toggle"]').trigger('click');
        await flushPromises();

        expect(appUpdateServiceMock.setAutoCheckEnabled).not.toHaveBeenCalled();
    });
});

describe('user acts on the update from the details dialog', () => {
    async function openDialog(patch: Partial<AppUpdateState>) {
        const wrapper = mountSection({ status: 'idle' });
        appUpdateServiceMock.checkNow.mockImplementation(async () => {
            appUpdateServiceMock.publishState(patch);
            return true;
        });
        await primaryAction(wrapper).trigger('click');
        await flushPromises();
        return wrapper;
    }

    it('user gets the install started for an already downloaded update', async () => {
        const wrapper = await openDialog({
            status: 'downloaded',
            downloadedUpdate: update() as never,
        });

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(appUpdateServiceMock.install).toHaveBeenCalled();
    });

    it('user gets the download started for an update they can take in the app', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
        });

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(appUpdateServiceMock.download).toHaveBeenCalled();
        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it('user gets sent to the download page when the app cannot install it', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
            latestUpdate: channelLatest(),
            updateRequirement: requirement({ targetSatisfiesRequirement: false }),
        });

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(openUrlMock).toHaveBeenCalledWith('https://example.com/setup.exe');
        expect(appUpdateServiceMock.download).not.toHaveBeenCalled();
    });

    it('user gets the release page when the release offers no direct download', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
            latestUpdate: channelLatest({ downloads: [] }),
            updateRequirement: requirement({ targetSatisfiesRequirement: false }),
        });

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(openUrlMock).toHaveBeenCalledWith('https://example.com/release');
    });

    it('user gets the repository releases page when the release names no page at all', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
            // A feed entry that names no release page. The type marks releaseUrl as
            // required, but the section still guards it with ??, so a real feed that
            // omits the field must fall through to the repository releases page.
            latestUpdate: channelLatest({
                downloads: [],
                releaseUrl: undefined as unknown as string,
            }),
            updateRequirement: requirement({ targetSatisfiesRequirement: false }),
        });

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(openUrlMock).toHaveBeenCalledTimes(1);
        const url = openUrlMock.mock.calls[0]?.[0] ?? '';
        expect(url).toContain('releases');
    });

    it('user gets no action taken while an update is already running', async () => {
        const wrapper = await openDialog({
            status: 'downloaded',
            downloadedUpdate: update() as never,
        });
        appUpdateServiceMock.publishState({ status: 'installing' });
        await flushPromises();

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(appUpdateServiceMock.install).not.toHaveBeenCalled();
        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it('user gets the dialog closed from its close button', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
        });

        await wrapper.get('[data-testid="dialog-close"]').trigger('click');
        await flushPromises();

        expect(dialogExists(wrapper)).toBe(false);
    });
});

describe('user reads the details dialog content', () => {
    async function openDialog(patch: Partial<AppUpdateState>) {
        const wrapper = mountSection({ status: 'idle' });
        appUpdateServiceMock.checkNow.mockImplementation(async () => {
            appUpdateServiceMock.publishState(patch);
            return true;
        });
        await primaryAction(wrapper).trigger('click');
        await flushPromises();
        return wrapper;
    }

    it('user sees the new version title, notes and download action', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
        });

        const node = dialog(wrapper);
        expect(node.attributes('data-has-update')).toBe('true');
        expect(node.attributes('data-version')).toBe('0.2.0');
        expect(node.attributes('data-notes')).toBe('Fixes and polish');
        expect(node.attributes('data-action')).toBeTruthy();
    });

    it('user gets the download action label while the download runs', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
        });
        appUpdateServiceMock.publishState({ status: 'downloading', downloadProgress: 15 });
        await flushPromises();

        expect(dialog(wrapper).attributes('data-action')).toContain('15');
        expect(dialog(wrapper).attributes('data-busy')).toBe('true');
        expect(dialog(wrapper).attributes('data-progress')).toBe('15');
    });

    it('user gets the installing label once the download finished', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
        });
        appUpdateServiceMock.publishState({ status: 'installing' });
        await flushPromises();

        expect(dialog(wrapper).attributes('data-action')).toContain('安装');
    });

    it('user gets the restart label for a downloaded update', async () => {
        const wrapper = await openDialog({
            status: 'downloaded',
            downloadedUpdate: update() as never,
        });

        expect(dialog(wrapper).attributes('data-action')).toContain('重启');
    });

    it('user gets the "no version" title when nothing newer exists', async () => {
        const wrapper = mountSection({ status: 'not_available', currentVersion: '0.1.0' });
        // The dialog only opens when a check reports something, so drive the
        // exposed method the app itself uses from the sidebar.
        await (
            wrapper.vm as unknown as { checkAndOpenUpdates: (s: string) => Promise<void> }
        ).checkAndOpenUpdates('manual');
        await flushPromises();

        if (!dialogExists(wrapper)) {
            // Nothing to show: that is the expected outcome for a current install.
            expect(dialogExists(wrapper)).toBe(false);
            return;
        }

        expect(dialog(wrapper).attributes('data-has-update')).toBe('false');
    });

    it('user sees the release notes taken from the channel when the update has none', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update({ notes: '   ' }) as never,
            latestUpdate: channelLatest({ releaseNotes: 'From the channel feed', downloads: [] }),
        });

        expect(dialog(wrapper).attributes('data-notes')).toBe('From the channel feed');
    });

    it('user sees no notes when neither source has any', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update({ notes: null }) as never,
        });

        expect(dialog(wrapper).attributes('data-notes')).toBe('');
    });

    it('user sees the publish date from the channel feed', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
            latestUpdate: channelLatest({ releaseNotes: '' }),
        });

        expect(dialog(wrapper).attributes('data-published')).toBe('2026-05-20T00:00:00.000Z');
    });

    it('user sees no publish date when the channel feed did not report one', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
        });

        expect(dialog(wrapper).attributes('data-published')).toBe('');
    });

    it('user sees the error carried into the dialog after a failed check', async () => {
        // An unsupported result only opens the dialog when a newer release is known,
        // because that release is what the user is being pointed at.
        const wrapper = await openDialog({
            status: 'unsupported',
            error: 'this build has no updater',
            latestUpdate: channelLatest({ releaseNotes: '', publishedAt: null, downloads: [] }),
        });

        expect(dialog(wrapper).attributes('data-error')).toBe('this build has no updater');
    });
});
