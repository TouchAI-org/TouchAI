<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import agentDesktopLogo from '@assets/logos/drivers/agent-desktop.svg';
    import cuaDriverLogo from '@assets/logos/drivers/cua-driver.svg';
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import {
        type ComputerUseApproval,
        computerUseService,
        type ComputerUseSettings,
        type ComputerUseStatus,
        DEFAULT_SETTINGS,
    } from '@services/ComputerUseService';
    import {
        COMPUTER_USE_GROUPS,
        type ComputerUseGroup,
        type ComputerUseGroups,
    } from '@services/ComputerUseService/capabilities';
    import type { ComputerUseDriverId } from '@services/NativeService/computerUse';
    import { open } from '@tauri-apps/plugin-dialog';
    import { computed, nextTick, onMounted, ref } from 'vue';

    import { getLocale, t } from '@/i18n';

    defineOptions({ name: 'ComputerUseSettings' });

    const settings = ref<ComputerUseSettings>({ ...DEFAULT_SETTINGS });
    const selectedDriver = ref<ComputerUseDriverId>('cua-driver');
    const statuses = ref<Partial<Record<ComputerUseDriverId, ComputerUseStatus>>>({});
    const status = computed(() => statuses.value[selectedDriver.value] ?? null);
    const busy = ref(false);
    const busyDriver = ref<ComputerUseDriverId | null>(null);
    const updatingDriver = ref<ComputerUseDriverId | null>(null);
    const driverOpen = ref(false);
    const enabled = ref(false);
    const saving = ref(new Set<keyof ComputerUseSettings>());
    const savingGroups = ref(new Set<ComputerUseGroup>());
    const pickingRecordingDirectory = ref(false);
    const recordingDirectory = ref('');
    const driverDirectory = ref('');
    const groups = ref<ComputerUseGroups>({});
    const alert = useAlert();
    const { confirm } = useConfirm();

    const installed = computed(() => isDriverAvailable(selectedDriver.value));
    const driverDisabled = computed(() => !enabled.value || busy.value);
    const driverMenuDisabled = computed(() => !enabled.value || (busy.value && !busyDriver.value));
    const preferencesDisabled = computed(() => driverDisabled.value || !installed.value);
    const drivers: ComputerUseDriverId[] = ['cua-driver', 'agent-desktop'];
    const driverLogos: Record<ComputerUseDriverId, string> = {
        'cua-driver': cuaDriverLogo,
        'agent-desktop': agentDesktopLogo,
    };

    function isDriverAvailable(driver: ComputerUseDriverId): boolean {
        return statuses.value[driver]?.installed === true && !statuses.value[driver]?.error;
    }

    const visibleGroups = computed(() =>
        COMPUTER_USE_GROUPS.filter(
            (group) => selectedDriver.value !== 'agent-desktop' || group !== 'browser'
        )
    );
    const driverOptions = computed(() =>
        drivers.map((driver) => ({
            value: driver,
            label: driver,
            iconSrc: driverLogos[driver],
            disabled: !isDriverAvailable(driver) || busy.value || updatingDriver.value !== null,
            description: driverDescription(statuses.value[driver]),
        }))
    );

    function driverDescription(driverStatus?: ComputerUseStatus): string | undefined {
        const details: string[] = [];
        if (driverStatus?.driverVersion) details.push(`v${driverStatus.driverVersion}`);
        const bytes = driverStatus?.installedSizeBytes;
        if (
            driverStatus?.installed &&
            typeof bytes === 'number' &&
            Number.isFinite(bytes) &&
            bytes > 0
        ) {
            const size = new Intl.NumberFormat(getLocale(), {
                style: 'unit',
                unit: 'megabyte',
                unitDisplay: 'short',
                maximumFractionDigits: 1,
            }).format(bytes / 1_000_000);
            details.push(size);
        }
        return details.join(' ') || undefined;
    }

    const approvalOptions = computed(() =>
        [
            {
                value: 'each' as const,
                label: t('settings.computerUse.approval.each'),
            },
            {
                value: 'session-window' as const,
                label: t('settings.computerUse.approval.session'),
            },
            {
                value: 'full-access' as const,
                label: t('settings.computerUse.approval.fullAccess'),
            },
        ].filter(
            (option) =>
                selectedDriver.value !== 'agent-desktop' || option.value !== 'session-window'
        )
    );

    const approvalValue = computed(() =>
        selectedDriver.value === 'agent-desktop' && settings.value.approval === 'session-window'
            ? 'each'
            : settings.value.approval
    );

    function capabilityLabel(group: ComputerUseGroup): string {
        if (
            selectedDriver.value === 'agent-desktop' &&
            (group === 'automation' || group === 'recording')
        ) {
            return t(`settings.computerUse.agentDesktop.capability.${group}`);
        }
        return t(`settings.computerUse.capability.${group}`);
    }

    function capabilityDescription(group: ComputerUseGroup): string {
        if (
            selectedDriver.value === 'agent-desktop' &&
            (group === 'automation' || group === 'recording')
        ) {
            return t(`settings.computerUse.agentDesktop.capability.${group}.description`);
        }
        return t(`settings.computerUse.capability.${group}.description`);
    }

    const screenshotOptions = computed<
        Array<{ description?: string; label: string; value: number }>
    >(() => {
        const options: Array<{ description?: string; label: string; value: number }> = [
            {
                value: 1024,
                label: t('settings.computerUse.screenshot.fast'),
                description: '1024 px',
            },
            {
                value: 1568,
                label: t('settings.computerUse.screenshot.balanced'),
                description: '1568 px',
            },
            {
                value: 2048,
                label: t('settings.computerUse.screenshot.sharp'),
                description: '2048 px',
            },
        ];
        if (!options.some((option) => option.value === settings.value.maxImageDimension)) {
            options.push({
                value: settings.value.maxImageDimension,
                label: `${settings.value.maxImageDimension} px`,
            });
        }
        return options;
    });

    async function refresh(): Promise<void> {
        await Promise.all(
            drivers.map(async (driver) => {
                try {
                    statuses.value[driver] = await computerUseService.status(driver);
                } catch (error) {
                    statuses.value[driver] = {
                        installed: false,
                        abiVersion: null,
                        binary: null,
                        driverVersion: null,
                        error: errorMessage(error),
                    };
                }
            })
        );
        selectedDriver.value = await computerUseService.loadDriver();
        if (settings.value.recordingEnabled) {
            recordingDirectory.value = await computerUseService.loadRecordingDirectory();
        }
    }

    async function selectDriver(driver: ComputerUseDriverId | ''): Promise<void> {
        if (!driver || driverDisabled.value || updatingDriver.value || !isDriverAvailable(driver))
            return;
        busy.value = true;
        try {
            await computerUseService.selectDriver(driver);
            selectedDriver.value = driver;
            recordingDirectory.value = await computerUseService.loadRecordingDirectory();
            await refresh();
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            busy.value = false;
        }
    }

    onMounted(async () => {
        try {
            settings.value = await computerUseService.loadSettings();
            selectedDriver.value = await computerUseService.loadDriver();
            enabled.value = await computerUseService.isEnabled();
            groups.value = await computerUseService.loadGroups();
            driverDirectory.value = await computerUseService.loadDriverDirectory();
            await refresh();
        } catch (error) {
            alert.error(errorMessage(error));
        }
    });

    async function setEnabled(value: boolean): Promise<void> {
        if (busy.value || saving.value.has('enabled')) return;
        saving.value.add('enabled');
        try {
            await computerUseService.setEnabled(value);
            enabled.value = value;
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            saving.value.delete('enabled');
        }
    }

    async function setGroup(group: ComputerUseGroup, value: boolean): Promise<void> {
        if (preferencesDisabled.value || savingGroups.value.has(group)) return;
        savingGroups.value.add(group);
        try {
            await computerUseService.setGroupEnabled(group, value);
            groups.value = { ...groups.value, [group]: value };
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            savingGroups.value.delete(group);
        }
    }

    async function prepare(driver: ComputerUseDriverId): Promise<void> {
        if (driverDisabled.value) return;
        busy.value = true;
        busyDriver.value = driver;
        try {
            const next = await computerUseService.prepare(driver);
            statuses.value[driver] = next;
            if (next.installed && !next.error) {
                if (!installed.value) {
                    await computerUseService.selectDriver(driver);
                    selectedDriver.value = driver;
                    recordingDirectory.value = await computerUseService.loadRecordingDirectory();
                }
                if (driver === selectedDriver.value)
                    await computerUseService.applySettings(settings.value);
                if (driver === selectedDriver.value && settings.value.recordingEnabled) {
                    await computerUseService.setRecording(true);
                }
                alert.success(t('settings.computerUse.status.installed'));
            } else {
                alert.error(next.error ?? t('settings.computerUse.status.missing'));
            }
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            busy.value = false;
            busyDriver.value = null;
        }
    }

    async function update<Key extends keyof ComputerUseSettings>(
        key: Key,
        value: ComputerUseSettings[Key]
    ): Promise<void> {
        if (preferencesDisabled.value || saving.value.has(key)) return;
        saving.value.add(key);
        try {
            const saved = await computerUseService.saveSettings({ [key]: value });
            settings.value = { ...settings.value, [key]: saved[key] };
            if (key === 'approval') {
                computerUseService.clearSessionApprovals();
            }
            if (key === 'maxImageDimension') {
                const failures = await computerUseService.applySettings(settings.value);
                if (failures.length > 0) {
                    alert.warning(failures[0]!);
                }
            }
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            saving.value.delete(key);
        }
    }

    async function setRecordingEnabled(value: boolean): Promise<void> {
        if (preferencesDisabled.value || saving.value.has('recordingEnabled')) return;
        saving.value.add('recordingEnabled');
        const previous = settings.value.recordingEnabled;
        try {
            if (value) recordingDirectory.value = await computerUseService.loadRecordingDirectory();
            await computerUseService.setRecording(value);
            try {
                const saved = await computerUseService.saveSettings({ recordingEnabled: value });
                settings.value = { ...settings.value, recordingEnabled: saved.recordingEnabled };
            } catch (error) {
                await computerUseService.setRecording(previous);
                throw error;
            }
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            saving.value.delete('recordingEnabled');
        }
    }

    async function pickDriverDirectory(): Promise<void> {
        if (driverDisabled.value) return;
        busy.value = true;
        try {
            const picked = await open({
                directory: true,
                multiple: false,
                defaultPath: driverDirectory.value || undefined,
                title: t('settings.computerUse.action.pickDriverDirectory'),
            });
            if (typeof picked === 'string' && picked !== driverDirectory.value) {
                driverDirectory.value = await computerUseService.saveDriverDirectory(picked);
                await refresh();
            }
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            busy.value = false;
        }
    }

    async function pickRecordingDirectory(): Promise<void> {
        if (
            preferencesDisabled.value ||
            !settings.value.recordingEnabled ||
            pickingRecordingDirectory.value
        )
            return;
        pickingRecordingDirectory.value = true;
        try {
            const picked = await open({
                directory: true,
                multiple: false,
                defaultPath: recordingDirectory.value || undefined,
                title: t('settings.computerUse.action.pickRecordingDirectory'),
            });
            if (typeof picked === 'string' && picked !== recordingDirectory.value) {
                recordingDirectory.value = await computerUseService.saveRecordingDirectory(picked);
            }
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            pickingRecordingDirectory.value = false;
        }
    }

    async function resetDriverDirectory(): Promise<void> {
        if (driverDisabled.value || !driverDirectory.value) return;
        busy.value = true;
        try {
            driverDirectory.value = await computerUseService.saveDriverDirectory('');
            await refresh();
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            busy.value = false;
        }
    }

    async function checkUpdate(driver: ComputerUseDriverId): Promise<void> {
        if (driverDisabled.value || updatingDriver.value) return;
        updatingDriver.value = driver;
        try {
            const info = await computerUseService.checkUpdate(driver);
            if (info.error) {
                alert.error(info.error);
                return;
            }
            if (!info.updateAvailable || !info.latest) {
                alert.success(t('settings.computerUse.update.current'));
                return;
            }
            if (driver === 'agent-desktop') {
                alert.success(t('settings.computerUse.update.available', { version: info.latest }));
                return;
            }
            const agreed = await confirm({
                message: t('settings.computerUse.update.confirm', {
                    driver,
                    version: info.latest,
                }),
                title: `${t('settings.computerUse.field.update')} ${driver}`,
                confirmText: t('settings.computerUse.update.confirmAction'),
            });
            if (!agreed) return;
            const next = await computerUseService.installUpdate(driver, info.latest);
            statuses.value[driver] = next;
            if (!next.installed || next.error) {
                alert.error(next.error ?? t('settings.computerUse.status.missing'));
                return;
            }
            if (next.driverVersion !== info.latest) {
                alert.warning(
                    t('settings.computerUse.update.restored', {
                        version: next.driverVersion ?? info.current,
                    })
                );
                return;
            }
            if (driver === selectedDriver.value) {
                try {
                    await computerUseService.applySettings(settings.value);
                    if (settings.value.recordingEnabled) {
                        await computerUseService.setRecording(true);
                    }
                } catch (error) {
                    alert.warning(errorMessage(error));
                }
            }
            alert.success(t('settings.computerUse.update.installed', { version: info.latest }));
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            updatingDriver.value = null;
        }
    }

    async function removeDriver(driver: ComputerUseDriverId): Promise<void> {
        if (driverDisabled.value || updatingDriver.value) return;
        busy.value = true;
        driverOpen.value = false;
        try {
            await nextTick();
            const agreed = await confirm({
                message: t('settings.computerUse.confirm.remove', { driver }),
                title: `${t('settings.computerUse.action.remove')} ${driver}`,
                type: 'danger',
            });
            if (!agreed) return;
            try {
                await computerUseService.remove(driver);
                alert.success(t('settings.computerUse.removed'));
            } catch (error) {
                alert.error(errorMessage(error));
            }
            await refresh();
        } catch (error) {
            alert.error(errorMessage(error));
        } finally {
            busy.value = false;
        }
    }

    function setApproval(approval: ComputerUseApproval): void {
        void update('approval', approval);
    }

    function setMaxImageDimension(value: number | string): void {
        const dimension = Number(value);
        if (!Number.isFinite(dimension) || dimension <= 0) return;
        void update('maxImageDimension', dimension);
    }

    function errorMessage(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'computer_use_storage_invalid')
            return t('settings.computerUse.storage.invalid');
        if (message === 'computer_use_storage_failed')
            return t('settings.computerUse.storage.failed');
        if (message === 'computer_use_storage_conflict')
            return t('settings.computerUse.storage.conflict');
        return message === 'computer_use_driver_unavailable'
            ? t('settings.computerUse.status.unavailable')
            : message;
    }
</script>

<template>
    <div class="settings-page" data-testid="settings-computer-use">
        <div class="settings-section-stack">
            <header class="settings-page-header flex items-start gap-4">
                <div class="max-w-2xl min-w-0">
                    <h1 class="settings-page-title">
                        {{ t('settings.nav.computerUse.label') }}
                    </h1>
                    <p class="settings-section-description">
                        {{ t('settings.nav.computerUse.description') }}
                    </p>
                </div>
                <Switch
                    data-testid="computer-use-enabled-toggle"
                    size="lg"
                    class="ml-auto shrink-0"
                    :aria-label="t('settings.nav.computerUse.label')"
                    :model-value="enabled"
                    :disabled="busy || saving.has('enabled')"
                    @update:model-value="setEnabled"
                />
            </header>

            <fieldset :disabled="driverMenuDisabled" class="settings-section-stack">
                <section class="space-y-4" aria-labelledby="computer-use-driver-heading">
                    <h2 id="computer-use-driver-heading" class="settings-section-title">
                        {{ t('settings.computerUse.group.basic') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-border/70">
                        <SettingsRow
                            data-settings-search-target="computer-use-driver"
                            control-width="320"
                            :label="t('settings.computerUse.field.driver')"
                            :description="status?.error || undefined"
                        >
                            <CustomSelect
                                v-model:open="driverOpen"
                                trigger-test-id="computer-use-driver-select"
                                content-test-id="computer-use-driver-options"
                                :aria-label="t('settings.computerUse.field.driver')"
                                :model-value="installed ? selectedDriver : ''"
                                :options="driverOptions"
                                :disabled="driverMenuDisabled"
                                protect-option-text
                                @update:model-value="selectDriver"
                            >
                                <template #trigger="{ option }">
                                    <span class="flex min-w-0 flex-1 items-center gap-2">
                                        <img
                                            v-if="option?.iconSrc"
                                            :src="option.iconSrc"
                                            alt=""
                                            aria-hidden="true"
                                            class="h-4 w-4 shrink-0 rounded-sm object-contain"
                                        />
                                        <span class="min-w-0 flex-1 truncate" translate="no">
                                            {{
                                                installed
                                                    ? selectedDriver
                                                    : t('settings.computerUse.selectDriver')
                                            }}
                                        </span>
                                    </span>
                                </template>
                                <template #option-actions="{ option }">
                                    <Button
                                        v-if="
                                            statuses[option.value] &&
                                            !statuses[option.value]?.installed
                                        "
                                        data-testid="computer-use-install"
                                        variant="ghost-neutral"
                                        :aria-label="`${t(busy ? 'common.loading' : 'settings.computerUse.action.prepare')} · ${option.label}`"
                                        :title="`${t(busy ? 'common.loading' : 'settings.computerUse.action.prepare')} · ${option.label}`"
                                        :aria-busy="busyDriver === option.value"
                                        :disabled="
                                            driverDisabled || updatingDriver === option.value
                                        "
                                        @click="prepare(option.value)"
                                    >
                                        <AppIcon
                                            v-if="busyDriver === option.value"
                                            name="loading"
                                            role="status"
                                            :aria-label="t('common.loading')"
                                            class="h-4 w-4 animate-spin"
                                        />
                                        <AppIcon v-else name="download" class="h-4 w-4" />
                                    </Button>
                                    <Button
                                        v-if="statuses[option.value]?.installed"
                                        data-testid="computer-use-check-update"
                                        variant="ghost-neutral"
                                        :aria-label="`${t('settings.computerUse.action.checkUpdate')} · ${option.label}`"
                                        :title="`${t('settings.computerUse.action.checkUpdate')} · ${option.label}`"
                                        :aria-busy="updatingDriver === option.value"
                                        :disabled="
                                            driverDisabled || updatingDriver === option.value
                                        "
                                        @click="checkUpdate(option.value)"
                                    >
                                        <AppIcon
                                            v-if="updatingDriver === option.value"
                                            name="loading"
                                            role="status"
                                            :aria-label="t('common.loading')"
                                            class="h-4 w-4 animate-spin"
                                        />
                                        <AppIcon v-else name="refresh" class="h-4 w-4" />
                                    </Button>
                                    <Button
                                        v-if="statuses[option.value]?.installed"
                                        data-testid="computer-use-remove"
                                        variant="ghost-neutral"
                                        :aria-label="`${t('settings.computerUse.action.remove')} · ${option.label}`"
                                        :title="`${t('settings.computerUse.action.remove')} · ${option.label}`"
                                        :disabled="
                                            driverDisabled || updatingDriver === option.value
                                        "
                                        @click="removeDriver(option.value)"
                                    >
                                        <AppIcon name="trash" class="h-4 w-4" />
                                    </Button>
                                </template>
                            </CustomSelect>
                        </SettingsRow>
                        <SettingsRow
                            data-settings-search-target="computer-use-driver-directory"
                            control-width="320"
                            control-class="flex items-center gap-2"
                            label-as="label"
                            label-for="computer-use-driver-directory"
                            :label="t('settings.computerUse.field.driverDirectory')"
                        >
                            <div class="relative min-w-0 flex-1">
                                <Input
                                    id="computer-use-driver-directory"
                                    data-testid="computer-use-driver-directory"
                                    variant="filled"
                                    :class="driverDirectory ? 'pr-10' : undefined"
                                    :model-value="driverDirectory"
                                    :placeholder="t('settings.computerUse.driverDirectory.default')"
                                    :title="driverDirectory"
                                    :disabled="driverDisabled"
                                    readonly
                                />
                                <Button
                                    v-if="driverDirectory"
                                    data-testid="computer-use-driver-directory-reset"
                                    variant="ghost-neutral"
                                    class="absolute top-1/2 right-1 -translate-y-1/2"
                                    :aria-label="
                                        t('settings.computerUse.action.resetDriverDirectory')
                                    "
                                    :title="t('settings.computerUse.action.resetDriverDirectory')"
                                    :disabled="driverDisabled"
                                    @click="resetDriverDirectory"
                                >
                                    <AppIcon name="x" class="h-4 w-4" />
                                </Button>
                            </div>
                            <Button
                                data-testid="computer-use-driver-directory-pick"
                                variant="ghost-neutral"
                                class="shrink-0"
                                :aria-label="t('settings.computerUse.action.pickDriverDirectory')"
                                :title="t('settings.computerUse.action.pickDriverDirectory')"
                                :disabled="driverDisabled"
                                @click="pickDriverDirectory"
                            >
                                <AppIcon name="folder-open" class="h-4 w-4" />
                            </Button>
                        </SettingsRow>
                        <SettingsRow
                            data-settings-search-target="computer-use-cursor"
                            control-width="auto"
                            :label="t('settings.computerUse.field.cursor')"
                            :description="t('settings.computerUse.hint.cursor')"
                        >
                            <Switch
                                data-testid="computer-use-cursor-toggle"
                                size="lg"
                                :aria-label="t('settings.computerUse.field.cursor')"
                                :model-value="settings.cursorVisible"
                                :disabled="preferencesDisabled || saving.has('cursorVisible')"
                                @update:model-value="
                                    (value: boolean) => update('cursorVisible', value)
                                "
                            />
                        </SettingsRow>
                        <SettingsRow
                            v-if="selectedDriver === 'cua-driver'"
                            data-settings-search-target="computer-use-max-image"
                            control-width="320"
                            :label="t('settings.computerUse.field.maxImage')"
                            :description="t('settings.computerUse.hint.maxImage')"
                        >
                            <CustomSelect
                                trigger-test-id="computer-use-max-image"
                                :aria-label="t('settings.computerUse.field.maxImage')"
                                :model-value="settings.maxImageDimension"
                                :options="screenshotOptions"
                                :disabled="preferencesDisabled || saving.has('maxImageDimension')"
                                @update:model-value="setMaxImageDimension"
                            />
                        </SettingsRow>
                        <SettingsRow
                            data-settings-search-target="computer-use-recording"
                            control-width="auto"
                            :label="t('settings.computerUse.field.recording')"
                            :description="t('settings.computerUse.hint.recording')"
                        >
                            <Switch
                                data-testid="computer-use-recording-toggle"
                                size="lg"
                                :aria-label="t('settings.computerUse.field.recording')"
                                :model-value="settings.recordingEnabled"
                                :disabled="preferencesDisabled || saving.has('recordingEnabled')"
                                @update:model-value="setRecordingEnabled"
                            />
                        </SettingsRow>
                        <SettingsRow
                            v-if="settings.recordingEnabled"
                            control-width="320"
                            control-class="flex items-center gap-2"
                            label-as="label"
                            label-for="computer-use-recording-directory"
                            :label="t('settings.computerUse.field.recordingDirectory')"
                        >
                            <Input
                                id="computer-use-recording-directory"
                                data-testid="computer-use-recording-directory"
                                variant="filled"
                                class="min-w-0 flex-1"
                                :model-value="recordingDirectory"
                                :title="recordingDirectory"
                                :disabled="preferencesDisabled || pickingRecordingDirectory"
                                readonly
                            />
                            <Button
                                data-testid="computer-use-recording-directory-pick"
                                variant="ghost-neutral"
                                class="shrink-0"
                                :aria-label="
                                    t('settings.computerUse.action.pickRecordingDirectory')
                                "
                                :title="t('settings.computerUse.action.pickRecordingDirectory')"
                                :disabled="preferencesDisabled || pickingRecordingDirectory"
                                @click="pickRecordingDirectory"
                            >
                                <AppIcon name="folder-open" class="h-4 w-4" />
                            </Button>
                        </SettingsRow>
                    </div>
                </section>

                <section class="space-y-4" aria-labelledby="computer-use-permission-heading">
                    <h2 id="computer-use-permission-heading" class="settings-section-title">
                        {{ t('settings.computerUse.group.permission') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-border/70">
                        <SettingsRow
                            data-settings-search-target="computer-use-approval-mode"
                            control-width="320"
                            :label="t('settings.computerUse.field.approval')"
                        >
                            <CustomSelect
                                trigger-test-id="computer-use-approval-mode"
                                :aria-label="t('settings.computerUse.field.approval')"
                                :model-value="approvalValue"
                                :options="approvalOptions"
                                :disabled="preferencesDisabled || saving.has('approval')"
                                @update:model-value="setApproval"
                            />
                        </SettingsRow>
                        <SettingsRow
                            data-settings-search-target="computer-use-foreground"
                            control-width="auto"
                            :label="t('settings.computerUse.field.foreground')"
                            :description="t('settings.computerUse.hint.foreground')"
                        >
                            <Switch
                                data-testid="computer-use-foreground-toggle"
                                size="lg"
                                :aria-label="t('settings.computerUse.field.foreground')"
                                :model-value="settings.allowForeground"
                                :disabled="preferencesDisabled || saving.has('allowForeground')"
                                @update:model-value="
                                    (value: boolean) => update('allowForeground', value)
                                "
                            />
                        </SettingsRow>

                        <div
                            data-settings-search-target="computer-use-capabilities"
                            class="divide-y divide-border/70"
                        >
                            <SettingsRow
                                v-for="group in visibleGroups"
                                :key="group"
                                control-width="auto"
                                :label="capabilityLabel(group)"
                                :description="capabilityDescription(group)"
                            >
                                <Switch
                                    :data-testid="`computer-use-group-${group}`"
                                    size="lg"
                                    :aria-label="capabilityLabel(group)"
                                    :model-value="groups[group] !== false"
                                    :disabled="preferencesDisabled || savingGroups.has(group)"
                                    @update:model-value="(value: boolean) => setGroup(group, value)"
                                />
                            </SettingsRow>
                        </div>
                    </div>
                </section>
            </fieldset>
        </div>
    </div>
</template>
