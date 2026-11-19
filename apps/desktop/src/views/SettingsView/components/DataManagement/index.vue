<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { useAlert } from '@composables/useAlert';
    import {
        databaseBackup,
        DatabaseBackupCancelledError,
        type ImportMode,
        isDatabaseBackupCancelledError,
        isDatabaseBackupCommittedError,
    } from '@database/backup';
    import { setMeta } from '@database/queries/touchaiMeta';
    import { MetaKey } from '@database/schema';
    import { log } from '@services/ObservabilityService';
    import { relaunch } from '@tauri-apps/plugin-process';
    import { useStateMachine } from 'reka-ui';
    import { computed, onUnmounted, ref } from 'vue';

    import { t, tt } from '@/i18n';
    import { serializeImportSuccessStartupPayload } from '@/services/StartupService';
    import { useSettingsStore } from '@/stores/settings';

    defineOptions({
        name: 'SettingsDataManagementSection',
    });

    import AnalyticsSection from './components/AnalyticsSection.vue';
    import BackupScopeDialog from './components/BackupScopeDialog.vue';
    import DataLocationRow from './components/DataLocationRow.vue';
    import DiagnosticsSection from './components/DiagnosticsSection.vue';
    import ProgressDialog from './components/ProgressDialog.vue';
    import StorageSection from './components/StorageSection.vue';

    // Dialog states
    const DIALOG_LIFECYCLE = {
        closed: { open: 'open', dispose: 'disposed' },
        open: { close: 'closing', dispose: 'disposed' },
        closing: { open: 'open', closed: 'closed', dispose: 'disposed' },
        disposed: {},
    } as const;
    const importDialog = useStateMachine('closed', DIALOG_LIFECYCLE);
    const backupAction = ref<'export' | 'import'>('export');
    const selectedImport = ref<Awaited<ReturnType<typeof databaseBackup.selectImport>>>(null);
    const showImportModeDialog = computed({
        get: () => importDialog.state.value === 'open',
        set: (open: boolean) => importDialog.dispatch(open ? 'open' : 'close'),
    });
    const isImportModeDialogMounted = computed(
        () => importDialog.state.value === 'open' || importDialog.state.value === 'closing'
    );

    // Progress Dialog states
    const progressDialog = useStateMachine('closed', DIALOG_LIFECYCLE);
    const showProgressDialog = computed({
        get: () => progressDialog.state.value === 'open',
        set: (open: boolean) => progressDialog.dispatch(open ? 'open' : 'close'),
    });
    const isProgressDialogMounted = computed(
        () => progressDialog.state.value === 'open' || progressDialog.state.value === 'closing'
    );
    const progressTitle = ref('');
    const progressMessage = ref('');
    const progressValue = ref(0);
    const progressStatus = ref<'loading' | 'success' | 'warning' | 'error'>('loading');
    const restartCountdown = ref<number | null>(null);

    const isLoading = ref(false);
    const storageBusy = ref(false);
    const locationBusy = ref(false);
    const cleanupVersion = ref(0);
    const dataActionsDisabled = computed(
        () => isLoading.value || storageBusy.value || locationBusy.value
    );
    let countdownTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const alert = useAlert();
    const settingsStore = useSettingsStore();

    /** 调用明细保留策略，默认永久（0） */
    const retentionOptions = computed(() =>
        [0, 30, 90, 365].map((days) => ({
            label:
                days === 0
                    ? t('settings.dataManagement.retention.forever')
                    : t('settings.dataManagement.retention.days', { days }),
            value: days,
        }))
    );

    const savingRetention = ref(false);

    async function saveRetention(days: number) {
        savingRetention.value = true;
        try {
            await settingsStore.updateUsageDetailRetentionDays(days);
            alert.success(t('settings.dataManagement.retention.saved'));
        } catch (error) {
            log.error('[DataManagement] Failed to save retention setting:', error);
            alert.error(t('settings.general.saveSettingsFailed'));
        } finally {
            savingRetention.value = false;
        }
    }

    const translateDataManagementMessage = (text: string) => tt(text);

    onUnmounted(() => {
        disposed = true;
        importDialog.dispatch('dispose');
        progressDialog.dispatch('dispose');
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        if (restartCountdown.value !== null) {
            void relaunch().catch((error) =>
                log.error('[DataManagement] Imported data requires a restart', error)
            );
        }
    });

    // 更新进度弹窗
    const updateProgress = (message: string, progress: number = 0) => {
        progressMessage.value = translateDataManagementMessage(message);
        progressValue.value = progress;
    };

    const handleExportSettings = async (mode: ImportMode) => {
        if (disposed || dataActionsDisabled.value) return;
        try {
            isLoading.value = true;
            progressTitle.value = t('settings.dataManagement.exporting');
            progressStatus.value = 'loading';

            const exportedPath = await databaseBackup.exportDatabase((msg, prog) => {
                if (disposed) {
                    if (prog < 100)
                        throw new DatabaseBackupCancelledError(
                            t('database.backup.exportCancelled')
                        );
                    return;
                }
                if (!showProgressDialog.value) {
                    showProgressDialog.value = true;
                }
                updateProgress(msg, prog);
            }, mode);

            if (disposed) return;
            showProgressDialog.value = false;
            alert.success(t('settings.dataManagement.exported', { path: exportedPath }));
        } catch (error) {
            log.error('Failed to export settings:', error);
            if (disposed) return;
            showProgressDialog.value = false;

            const message =
                error instanceof Error ? error.message : t('settings.dataManagement.exportFailed');
            if (!isDatabaseBackupCancelledError(error)) {
                alert.error(translateDataManagementMessage(message));
            }
        } finally {
            if (!disposed) isLoading.value = false;
        }
    };

    const chooseBackupScope = async (action: 'export' | 'import') => {
        if (disposed || dataActionsDisabled.value) return;
        backupAction.value = action;
        selectedImport.value = null;
        if (action === 'import') {
            isLoading.value = true;
            try {
                const selection = await databaseBackup.selectImport();
                if (disposed || !selection) return;
                selectedImport.value = selection;
            } catch (error) {
                log.error('Failed to read backup contents', error);
                if (!disposed) alert.error(t('settings.backup.scope.readFailed'));
                return;
            } finally {
                if (!disposed) isLoading.value = false;
            }
        }
        showImportModeDialog.value = true;
    };

    const confirmBackupScope = (mode: ImportMode) => {
        if (disposed || dataActionsDisabled.value) return;
        showImportModeDialog.value = false;
        if (backupAction.value === 'export') return handleExportSettings(mode);
        if (selectedImport.value) return handleImportSettings(mode, selectedImport.value.path);
    };

    const handleImportModeDialogClosed = () => {
        importDialog.dispatch('closed');
    };

    const handleProgressDialogClosed = () => {
        progressDialog.dispatch('closed');
    };

    const startRestartCountdown = async () => {
        progressStatus.value = 'success';
        progressTitle.value = t('settings.dataManagement.importSuccess');
        restartCountdown.value = 3;
        progressMessage.value = t('settings.dataManagement.restartCountdown', {
            seconds: restartCountdown.value,
        });

        countdownTimer = setInterval(() => {
            if (restartCountdown.value !== null && restartCountdown.value > 0) {
                restartCountdown.value--;
                progressMessage.value = t('settings.dataManagement.restartCountdown', {
                    seconds: restartCountdown.value,
                });
            } else {
                if (countdownTimer) {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                }
                void relaunch().catch((error) => {
                    log.error('[DataManagement] Imported data requires a manual restart', error);
                    if (!disposed) alert.warning(t('database.backup.restartRequired'));
                });
            }
        }, 1000);
    };

    const finishImportedData = async (mode: ImportMode) => {
        try {
            await setMeta({
                key: MetaKey.IMPORT_SUCCESS,
                value: serializeImportSuccessStartupPayload(mode),
            });
        } catch (error) {
            log.warn(
                '[DataManagement] Imported data committed but startup notice could not be saved',
                error
            );
        }
        try {
            if (disposed) {
                await relaunch();
            } else {
                await startRestartCountdown();
            }
        } catch (error) {
            log.error('[DataManagement] Imported data requires a manual restart', error);
            if (!disposed) alert.warning(t('database.backup.restartRequired'));
        }
    };

    const handleImportSettings = async (mode: ImportMode, path: string) => {
        if (disposed || dataActionsDisabled.value) return;

        try {
            isLoading.value = true;
            progressTitle.value = t('settings.dataManagement.importing');
            progressStatus.value = 'loading';
            restartCountdown.value = null;

            const result = await databaseBackup.importDatabase(
                mode,
                (msg, prog) => {
                    if (disposed) {
                        if (prog < 100)
                            throw new DatabaseBackupCancelledError(
                                t('database.backup.importCancelled')
                            );
                        return;
                    }
                    if (!showProgressDialog.value) {
                        showProgressDialog.value = true;
                    }
                    updateProgress(msg, prog);
                },
                path
            );

            if (!result) {
                showProgressDialog.value = false;
                return;
            }

            await finishImportedData(mode);
        } catch (error) {
            if (isDatabaseBackupCommittedError(error)) {
                if (!disposed) alert.warning(error.message);
                await finishImportedData(mode);
                return;
            }
            log.error('Failed to import settings:', error);
            if (disposed) return;
            showProgressDialog.value = false;

            const message =
                error instanceof Error ? error.message : t('settings.dataManagement.importFailed');
            if (!isDatabaseBackupCancelledError(error)) {
                alert.error(translateDataManagementMessage(message));
            }
        } finally {
            if (!disposed) isLoading.value = false;
        }
    };
</script>

<template>
    <div class="settings-page">
        <div class="settings-section-stack">
            <header class="settings-page-header">
                <h1 class="settings-page-title">{{ t('settings.nav.dataManagement.label') }}</h1>
            </header>

            <StorageSection
                :disabled="isLoading || locationBusy"
                @busy-change="storageBusy = $event"
                @cleaned="cleanupVersion++"
            >
                <div class="settings-row-group divide-y divide-border-subtle">
                    <DataLocationRow
                        :disabled="isLoading || storageBusy"
                        @busy-change="locationBusy = $event"
                    />
                    <SettingsRow
                        data-testid="settings-data-retention-row"
                        data-settings-search-target="data-retention"
                        control-width="180"
                        :label="t('settings.dataManagement.retention.label')"
                        :description="t('settings.dataManagement.retention.description')"
                    >
                        <CustomSelect
                            :model-value="settingsStore.usageDetailRetentionDays"
                            :options="retentionOptions"
                            :disabled="savingRetention || dataActionsDisabled"
                            trigger-test-id="settings-data-retention-trigger"
                            @update:model-value="saveRetention"
                        />
                    </SettingsRow>
                </div>
            </StorageSection>

            <section class="space-y-4">
                <h2 class="settings-section-title">
                    {{ t('settings.dataManagement.settingsBackup') }}
                </h2>
                <div class="settings-row-group divide-y divide-border-subtle">
                    <SettingsRow
                        data-testid="settings-data-plain-row"
                        data-settings-search-target="export-settings"
                        control-width="auto"
                        :label="t('settings.dataManagement.exportSettings')"
                        :description="t('settings.dataManagement.exportSettingsDescription')"
                    >
                        <Button
                            variant="strong"
                            :disabled="dataActionsDisabled"
                            @click="chooseBackupScope('export')"
                        >
                            {{ t('common.export') }}
                        </Button>
                    </SettingsRow>

                    <SettingsRow
                        data-testid="settings-data-plain-row"
                        data-settings-search-target="import-settings"
                        control-width="auto"
                        :label="t('settings.dataManagement.importSettings')"
                        :description="t('settings.dataManagement.importSettingsDescription')"
                    >
                        <Button
                            variant="strong"
                            :disabled="dataActionsDisabled"
                            @click="chooseBackupScope('import')"
                        >
                            {{ t('common.import') }}
                        </Button>
                    </SettingsRow>
                </div>
            </section>

            <AnalyticsSection />

            <DiagnosticsSection :refresh-token="cleanupVersion" />

            <BackupScopeDialog
                v-if="isImportModeDialogMounted"
                :action="backupAction"
                :available="selectedImport?.scope ?? 'full'"
                :open="showImportModeDialog"
                :is-loading="dataActionsDisabled"
                @close="showImportModeDialog = false"
                @select="confirmBackupScope"
                @closed="handleImportModeDialogClosed"
            />

            <ProgressDialog
                v-if="isProgressDialogMounted"
                :open="showProgressDialog"
                :title="progressTitle"
                :message="progressMessage"
                :progress="progressValue"
                :status="progressStatus"
                @closed="handleProgressDialogClosed"
            />
        </div>
    </div>
</template>
