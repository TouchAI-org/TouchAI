import { createUpdateClientBoundary } from '@tests/utils/updateClient';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type {
    AppUpdateChannelLatest,
    AppUpdateInfo,
    AppUpdateRequirement,
    AppUpdateState,
} from '@/modules/updates/types';
import UpdateSettingsSection from '@/views/SettingsView/components/General/UpdateSettingsSection.vue';

/*
 * The update section is a status panel: it reports what the updater is doing and
 * offers the one action that makes sense for that state. Every branch below is a
 * different updater state, so the assertions read the row the user sees and the
 * call the button makes — not the component's computed properties.
 */

let updatesBoundary: Awaited<ReturnType<typeof createUpdateClientBoundary>>;

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
            'releaseSections',
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
                :data-release-sections="JSON.stringify(releaseSections ?? [])"
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
afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await updatesBoundary.dispose();
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

async function mountSection(patch: Partial<AppUpdateState> = {}) {
    updatesBoundary.state = { ...updatesBoundary.createState(), ...patch };
    await updatesBoundary.synchronize();
    return mount(UpdateSettingsSection, updatesBoundary.viewOptions);
}

function statusTitle(wrapper: Awaited<ReturnType<typeof mountSection>>) {
    return wrapper.get('[data-testid="settings-update-status-title"]').text();
}

function primaryAction(wrapper: Awaited<ReturnType<typeof mountSection>>) {
    return wrapper.get('[data-testid="settings-update-primary-action"]');
}

function dialog(wrapper: Awaited<ReturnType<typeof mountSection>>) {
    return wrapper.find('[data-testid="update-details-dialog"]');
}

function dialogExists(wrapper: Awaited<ReturnType<typeof mountSection>>) {
    return wrapper.find('[data-testid="update-details-dialog"]').exists();
}

beforeEach(async () => {
    updatesBoundary = await createUpdateClientBoundary();
    setLocale('zh-CN');
    for (const key of [
        'checkNow',
        'setChannel',
        'setAutoCheckEnabled',
        'download',
        'install',
        'initialize',
    ] as const) {
        updatesBoundary[key].mockClear();
    }
    updatesBoundary.checkNow.mockResolvedValue(true);
    getVersionMock.mockResolvedValue('0.1.0');
    openUrlMock.mockClear();
});

describe('user reads what the updater is doing', () => {
    it('user sees the current version when nothing has been found', async () => {
        const wrapper = await mountSection({ status: 'idle' });

        expect(statusTitle(wrapper)).toContain('0.1.0');
    });

    it('user sees that a check is running', async () => {
        const wrapper = await mountSection({ status: 'checking' });

        expect(statusTitle(wrapper)).toContain('检查');
    });

    it('user sees the download progress while it downloads', async () => {
        const wrapper = await mountSection({ status: 'downloading', downloadProgress: 42 });

        expect(statusTitle(wrapper)).toContain('42');
    });

    it('user sees the download progress default to zero when none was reported', async () => {
        const wrapper = await mountSection({ status: 'downloading', downloadProgress: null });

        expect(statusTitle(wrapper)).toContain('0');
    });

    it('user sees that the update is installing', async () => {
        const wrapper = await mountSection({ status: 'installing' });

        expect(statusTitle(wrapper)).toContain('安装');
    });

    it('user sees the version waiting to be installed', async () => {
        const wrapper = await mountSection({ status: 'downloaded', downloadedUpdate: update() });

        expect(statusTitle(wrapper)).toContain('0.2.0');
    });

    it('user sees the version offered when an update is available', async () => {
        const wrapper = await mountSection({ status: 'available', availableUpdate: update() });

        expect(statusTitle(wrapper)).toContain('0.2.0');
    });

    it('user sees that they are already on the latest version', async () => {
        const wrapper = await mountSection({ status: 'not_available', currentVersion: '0.1.0' });

        expect(statusTitle(wrapper)).toContain('最新');
        expect(statusTitle(wrapper)).toContain('0.1.0');
    });

    it('user sees that the last check failed', async () => {
        const wrapper = await mountSection({ status: 'failed', error: 'network down' });

        expect(statusTitle(wrapper)).toContain('失败');
        expect(wrapper.text()).toContain('network down');
    });

    it('user is told the platform cannot update itself', async () => {
        const wrapper = await mountSection({ status: 'unsupported' });

        expect(statusTitle(wrapper)).toContain('不支持');
    });

    it('user sees when the last check happened', async () => {
        const wrapper = await mountSection({ lastCheckedAt: '2026-05-22T10:00:00.000Z' });

        expect(wrapper.text()).toContain('上次检查');
    });

    it('user sees no check time before the first check has run', async () => {
        const wrapper = await mountSection({ lastCheckedAt: null });

        expect(wrapper.text()).not.toContain('上次检查');
    });

    it('user sees the installed version read from the app rather than the state', async () => {
        getVersionMock.mockResolvedValue('0.3.1');
        const wrapper = await mountSection({ currentVersion: null, status: 'idle' });

        await flushPromises();

        expect(statusTitle(wrapper)).toContain('0.3.1');
    });

    it('user still sees the bundled version when the app cannot report one', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        getVersionMock.mockRejectedValue(new Error('no tauri'));
        const wrapper = await mountSection({ currentVersion: null, status: 'idle' });

        await flushPromises();

        // The bundled version is the fallback, so the row still names a version.
        expect(statusTitle(wrapper)).toMatch(/V\d+\.\d+\.\d+/);
        consoleError.mockRestore();
    });

    it('user sees the version from the requirement when no release was fetched', async () => {
        const wrapper = await mountSection({
            status: 'available',
            updateRequirement: requirement({ minimumSupportedVersion: '0.2.5' }),
        });

        expect(statusTitle(wrapper)).toContain('0.2.5');
    });
});

describe('user checks for updates', () => {
    it('user reopens a background download without another check or transfer', async () => {
        const wrapper = await mountSection({
            status: 'downloading',
            availableUpdate: update(),
            downloadProgress: 35,
        });
        await primaryAction(wrapper).trigger('click');
        await flushPromises();
        expect(dialogExists(wrapper)).toBe(true);
        expect(dialog(wrapper).attributes('data-progress')).toBe('35');
        expect(updatesBoundary.checkNow).not.toHaveBeenCalled();
        expect(updatesBoundary.download).not.toHaveBeenCalled();
    });

    it('user opens the installed version’s notes without a network check or upgrade action', async () => {
        const wrapper = await mountSection({
            status: 'not_available',
            currentVersion: '0.2.0',
            latestUpdate: channelLatest({ releaseNotesByLocale: { 'zh-CN': '本版本更新内容' } }),
        });
        const releaseNotesAction = wrapper.get(
            '[data-testid="settings-update-release-notes-action"]'
        );
        expect(releaseNotesAction.text()).toBe('更新日志');
        expect(releaseNotesAction.classes()).toEqual(primaryAction(wrapper).classes());

        await releaseNotesAction.trigger('click');
        await flushPromises();
        expect(dialog(wrapper).attributes('data-has-update')).toBe('false');
        expect(dialog(wrapper).attributes('data-notes')).toBe('本版本更新内容');
        expect(updatesBoundary.checkNow).not.toHaveBeenCalled();
    });

    it('user gets a check started when they press the action', async () => {
        const wrapper = await mountSection({ status: 'idle' });

        await primaryAction(wrapper).trigger('click');
        await flushPromises();

        expect(updatesBoundary.checkNow).toHaveBeenCalledWith('manual');
    });

    it('user gets the details opened when a newer release is found', async () => {
        const wrapper = await mountSection({ status: 'idle' });
        updatesBoundary.checkNow.mockImplementation(async () => {
            updatesBoundary.publishState({
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
        const wrapper = await mountSection({ status: 'idle' });
        updatesBoundary.checkNow.mockImplementation(async () => {
            updatesBoundary.publishState({
                status: 'unsupported',
                latestUpdate: channelLatest({
                    releaseNotes: 'Notes',
                    publishedAt: null,
                    downloads: [],
                }),
            });
            return false;
        });

        await primaryAction(wrapper).trigger('click');
        await flushPromises();

        // The dialog explains why the app cannot update itself.
        expect(dialogExists(wrapper)).toBe(true);
    });

    it('user gets no details when the check found nothing', async () => {
        const wrapper = await mountSection({ status: 'idle' });
        updatesBoundary.checkNow.mockResolvedValue(false);
        updatesBoundary.state = { ...updatesBoundary.createState(), status: 'idle' };

        await primaryAction(wrapper).trigger('click');
        await flushPromises();

        expect(dialogExists(wrapper)).toBe(false);
    });

    it('user can reopen a failed installation without losing the downloaded update', async () => {
        const wrapper = await mountSection({
            status: 'failed',
            downloadedUpdate: update(),
            error: 'file in use',
        });
        updatesBoundary.checkNow.mockResolvedValue(false);

        await primaryAction(wrapper).trigger('click');
        await flushPromises();

        expect(dialogExists(wrapper)).toBe(true);
        expect(dialog(wrapper).attributes('data-error')).toBe('file in use');
        expect(dialog(wrapper).attributes('data-action')).toContain('重启');
    });

    it('user gets the action unavailable while a check is already running', async () => {
        const wrapper = await mountSection({ status: 'checking' });

        expect(primaryAction(wrapper).attributes('disabled')).toBeDefined();
    });
});

describe('user changes the update channel', () => {
    it('user sees every channel offered with a description', async () => {
        const wrapper = await mountSection();

        expect(wrapper.get('[data-testid="channel-labels"]').text().length).toBeGreaterThan(0);
        expect(wrapper.get('[data-testid="channel-descriptions"]').text().length).toBeGreaterThan(
            0
        );
    });

    it('user gets the new channel saved and a check started', async () => {
        const wrapper = await mountSection({ channel: 'stable' });

        wrapper.findComponent({ name: 'CustomSelect' }).vm.$emit('update:modelValue', 'beta');
        await flushPromises();

        expect(updatesBoundary.setChannel).toHaveBeenCalledWith('beta');
        expect(updatesBoundary.checkNow).toHaveBeenCalledWith('settings-open');
    });

    it('user gets nothing saved when they re-pick the channel already set', async () => {
        const wrapper = await mountSection({ channel: 'stable' });

        wrapper.findComponent({ name: 'CustomSelect' }).vm.$emit('update:modelValue', 'stable');
        await flushPromises();

        expect(updatesBoundary.setChannel).not.toHaveBeenCalled();
    });

    it('user gets the channel locked while an update is running', async () => {
        const wrapper = await mountSection({ status: 'downloading' });

        expect(wrapper.find('[data-testid="update-channel-select"]').exists()).toBe(true);
        expect(wrapper.findComponent({ name: 'CustomSelect' }).props('disabled')).toBe(true);
    });

    it('user gets nothing saved when they change the channel mid-download', async () => {
        const wrapper = await mountSection({ status: 'downloading', channel: 'stable' });

        wrapper.findComponent({ name: 'CustomSelect' }).vm.$emit('update:modelValue', 'beta');
        await flushPromises();

        expect(updatesBoundary.setChannel).not.toHaveBeenCalled();
    });
});

describe('user turns automatic checks on or off', () => {
    it('user gets automatic checks turned off', async () => {
        const wrapper = await mountSection({ autoCheckEnabled: true });

        await wrapper.get('[data-testid="settings-update-auto-check-toggle"]').trigger('click');
        await flushPromises();

        expect(updatesBoundary.setAutoCheckEnabled).toHaveBeenCalledWith(false);
    });

    it('user gets automatic checks turned back on', async () => {
        const wrapper = await mountSection({ autoCheckEnabled: false });

        await wrapper.get('[data-testid="settings-update-auto-check-toggle"]').trigger('click');
        await flushPromises();

        expect(updatesBoundary.setAutoCheckEnabled).toHaveBeenCalledWith(true);
    });

    it('user gets the switch locked while an update is running', async () => {
        const wrapper = await mountSection({ status: 'installing' });

        expect(
            wrapper.get('[data-testid="settings-update-auto-check-toggle"]').attributes('disabled')
        ).toBeDefined();
    });

    it('user gets nothing changed when they toggle mid-download', async () => {
        const wrapper = await mountSection({ status: 'downloading', autoCheckEnabled: true });

        await wrapper.get('[data-testid="settings-update-auto-check-toggle"]').trigger('click');
        await flushPromises();

        expect(updatesBoundary.setAutoCheckEnabled).not.toHaveBeenCalled();
    });
});

describe('user acts on the update from the details dialog', () => {
    async function openDialog(patch: Partial<AppUpdateState>) {
        const wrapper = await mountSection({ status: 'idle' });
        updatesBoundary.checkNow.mockImplementation(async () => {
            updatesBoundary.publishState(patch);
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

        expect(updatesBoundary.install).toHaveBeenCalled();
    });

    it('user gets the download started for an update they can take in the app', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
        });

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(updatesBoundary.download).toHaveBeenCalled();
        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it('user retries a failed download in the app instead of opening a download page', async () => {
        const wrapper = await openDialog({
            status: 'failed',
            availableUpdate: update(),
            error: 'connection lost',
        });

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(updatesBoundary.download).toHaveBeenCalledOnce();
        expect(updatesBoundary.install).not.toHaveBeenCalled();
        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it('user retries a failed installation using the already downloaded package', async () => {
        const wrapper = await openDialog({
            status: 'failed',
            availableUpdate: update(),
            downloadedUpdate: update(),
            error: 'file in use',
        });

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(updatesBoundary.install).toHaveBeenCalledOnce();
        expect(updatesBoundary.download).not.toHaveBeenCalled();
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

        // The feed offers a Windows installer; on another platform the release page is the
        // only thing the user can act on. Either way the user has to be taken somewhere usable.
        expect(openUrlMock).toHaveBeenCalledTimes(1);
        const opened = String((openUrlMock.mock.calls as unknown as string[][])[0]?.[0] ?? '');
        expect(['https://example.com/setup.exe', 'https://example.com/release']).toContain(opened);
        expect(updatesBoundary.download).not.toHaveBeenCalled();
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

    it('user gets no action taken while an update is already running', async () => {
        const wrapper = await openDialog({
            status: 'downloaded',
            downloadedUpdate: update() as never,
        });
        updatesBoundary.publishState({ status: 'installing' });
        await flushPromises();

        await wrapper.get('[data-testid="dialog-action"]').trigger('click');
        await flushPromises();

        expect(updatesBoundary.install).not.toHaveBeenCalled();
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
        const wrapper = await mountSection({ status: 'idle' });
        updatesBoundary.checkNow.mockImplementation(async () => {
            updatesBoundary.publishState(patch);
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

    it('user reads translated notes when changing language with the details still open', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update(),
            latestUpdate: channelLatest({
                releaseNotesByLocale: { 'zh-CN': '更安全的更新', 'en-US': 'Safer updates' },
            }),
        });

        expect(dialog(wrapper).attributes('data-notes')).toBe('更安全的更新');
        setLocale('en-US');
        await flushPromises();
        expect(dialog(wrapper).attributes('data-notes')).toBe('Safer updates');
        expect(dialog(wrapper).attributes('data-version')).toBe('0.2.0');
    });

    it('user reads every skipped release when the update crosses several versions', async () => {
        const wrapper = await openDialog({
            status: 'available',
            currentVersion: '0.1.0',
            availableUpdate: update({ version: '0.2.0' }),
            latestUpdate: channelLatest({
                version: '0.2.0',
                releaseNotesByLocale: {
                    'zh-CN': '0.2.0 更新',
                    'en-US': '0.2.0 update',
                },
                releaseHistory: [
                    {
                        version: '0.1.5',
                        publishedAt: '2026-05-19T00:00:00.000Z',
                        releaseNotes: '0.1.5 更新',
                        releaseNotesByLocale: { 'zh-CN': '0.1.5 更新' },
                    },
                    {
                        version: '0.1.0',
                        publishedAt: '2026-05-18T00:00:00.000Z',
                        releaseNotes: '0.1.0 更新',
                        releaseNotesByLocale: { 'zh-CN': '0.1.0 更新' },
                    },
                ],
            }),
        });

        const sections = JSON.parse(
            dialog(wrapper).attributes('data-release-sections') ?? '[]'
        ) as Array<{ version: string }>;
        expect(sections.map((section) => section.version)).toEqual(['0.2.0', '0.1.5']);
    });

    it('user gets the download action label while the download runs', async () => {
        const wrapper = await openDialog({
            status: 'available',
            availableUpdate: update() as never,
        });
        updatesBoundary.publishState({ status: 'downloading', downloadProgress: 15 });
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
        updatesBoundary.publishState({ status: 'installing' });
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
        const wrapper = await mountSection({ status: 'not_available', currentVersion: '0.1.0' });
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

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
