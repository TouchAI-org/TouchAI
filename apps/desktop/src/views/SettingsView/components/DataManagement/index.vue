<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import { Button } from '@components/ui/button';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import {
        databaseBackup,
        DatabaseBackupCancelledError,
        type ImportMode,
        isDatabaseBackupCancelledError,
        isDatabaseBackupCommittedError,
    } from '@database/backup';
    import {
        countMessages,
        countSessions,
        countSessionTurns,
        getStatistic,
    } from '@database/queries';
    import { setMeta } from '@database/queries/touchaiMeta';
    import { MetaKey, StatisticKey } from '@database/schema';
    import { log } from '@services/ObservabilityService';
    import { relaunch } from '@tauri-apps/plugin-process';
    import { useStateMachine } from 'reka-ui';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { t, tt } from '@/i18n';
    import { formatDateTime } from '@/i18n/format';
    import { updateModelMetadata } from '@/services/AgentService/infrastructure/modelMetadata';
    import { serializeImportSuccessStartupPayload } from '@/services/StartupService';
    import { storageService } from '@/services/StorageService';
    import { useSettingsStore } from '@/stores/settings';

    defineOptions({
        name: 'SettingsDataManagementSection',
    });

    import AnalyticsSection from './components/AnalyticsSection.vue';
    import BackupScopeDialog from './components/BackupScopeDialog.vue';
    import DiagnosticsSection from './components/DiagnosticsSection.vue';
    import ProgressDialog from './components/ProgressDialog.vue';
    import StorageSection from './components/StorageSection.vue';

    interface DataStats {
        sessions: number;
        messages: number;
        sessionTurns: number;
    }

    const stats = ref<DataStats>({
        sessions: 0,
        messages: 0,
        sessionTurns: 0,
    });

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
    const storageSection = ref<InstanceType<typeof StorageSection> | null>(null);
    const storageBusy = ref(false);
    const dataActionsDisabled = computed(() => isLoading.value || storageBusy.value);
    const modelMetadataLastUpdatedAt = ref<string | null>(null);
    let countdownTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const alert = useAlert();
    const { confirm } = useConfirm();
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

    const modelMetadataUpdatedText = computed(() => {
        if (!modelMetadataLastUpdatedAt.value) {
            return t('settings.dataManagement.lastUpdatedNone');
        }

        const date = new Date(modelMetadataLastUpdatedAt.value);
        if (Number.isNaN(date.getTime())) {
            return t('settings.dataManagement.lastUpdated', {
                time: modelMetadataLastUpdatedAt.value,
            });
        }

        return t('settings.dataManagement.lastUpdated', {
            time: formatDateTime(date),
        });
    });

    const translateDataManagementMessage = (text: string) => tt(text);

    const loadMetadataUpdatedAt = async () => {
        const value = await getStatistic({
            key: StatisticKey.MODEL_METADATA_LAST_UPDATED_AT,
        });
        if (!disposed) modelMetadataLastUpdatedAt.value = value;
    };

    const loadStats = async () => {
        if (disposed) return;
        try {
            const [sessionsCount, messagesCount, sessionTurnsCount] = await Promise.all([
                countSessions(),
                countMessages(),
                countSessionTurns(),
            ]);
            if (disposed) return;

            stats.value = {
                sessions: sessionsCount,
                messages: messagesCount,
                sessionTurns: sessionTurnsCount,
            };
        } catch (error) {
            if (disposed) return;
            log.error('Failed to load stats:', error);
            alert.error(t('settings.dataManagement.loadStatsFailed'));
        }
    };

    async function recoverCommittedClear(error: unknown): Promise<boolean> {
        const message =
            typeof error === 'string' ? error : error instanceof Error ? error.message : '';
        if (!message.startsWith('storage_history_committed:')) return false;
        if (!disposed) {
            await loadStats();
            await storageSection.value?.refresh();
            alert.warning(t('settings.storage.historyCleanupPending'));
        }
        return true;
    }

    onMounted(async () => {
        await Promise.all([loadStats(), loadMetadataUpdatedAt()]);
    });

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

    const handleClearSessions = async () => {
        if (disposed || dataActionsDisabled.value) return;
        const confirmed = await confirm({
            title: t('settings.dataManagement.clearAllSessions'),
            message: t('settings.dataManagement.clearAllSessionsConfirm'),
            type: 'danger',
        });

        if (confirmed && !disposed && !dataActionsDisabled.value) {
            try {
                isLoading.value = true;
                await storageService.clearHistory('sessions');
                if (disposed) return;
                alert.success(t('settings.dataManagement.clearSessionsSuccess'));
                await loadStats();
                await storageSection.value?.refresh();
            } catch (error) {
                log.error('Failed to clear sessions:', error);
                if (disposed) return;
                if (await recoverCommittedClear(error)) return;
                alert.error(t('settings.dataManagement.clearSessionsFailed'));
            } finally {
                if (!disposed) isLoading.value = false;
            }
        }
    };

    const handleClearMessages = async () => {
        if (disposed || dataActionsDisabled.value) return;
        const confirmed = await confirm({
            title: t('settings.dataManagement.clearAllMessages'),
            message: t('settings.dataManagement.clearAllMessagesConfirm'),
            type: 'danger',
        });

        if (confirmed && !disposed && !dataActionsDisabled.value) {
            try {
                isLoading.value = true;
                await storageService.clearHistory('messages');
                if (disposed) return;
                alert.success(t('settings.dataManagement.clearMessagesSuccess'));
                await loadStats();
                await storageSection.value?.refresh();
            } catch (error) {
                log.error('Failed to clear messages:', error);
                if (disposed) return;
                if (await recoverCommittedClear(error)) return;
                alert.error(t('settings.dataManagement.clearMessagesFailed'));
            } finally {
                if (!disposed) isLoading.value = false;
            }
        }
    };

    const handleClearSessionTurns = async () => {
        if (disposed || dataActionsDisabled.value) return;
        const confirmed = await confirm({
            title: t('settings.dataManagement.clearSessionTurns'),
            message: t('settings.dataManagement.clearSessionTurnsConfirm'),
            type: 'danger',
        });

        if (confirmed && !disposed && !dataActionsDisabled.value) {
            try {
                isLoading.value = true;
                await storageService.clearHistory('turns');
                if (disposed) return;
                alert.success(t('settings.dataManagement.clearSessionTurnsSuccess'));
                await loadStats();
                await storageSection.value?.refresh();
            } catch (error) {
                log.error('Failed to clear session turns:', error);
                if (disposed) return;
                if (await recoverCommittedClear(error)) return;
                alert.error(t('settings.dataManagement.clearSessionTurnsFailed'));
            } finally {
                if (!disposed) isLoading.value = false;
            }
        }
    };

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

    const handleUpdateModelMetadata = async () => {
        try {
            isLoading.value = true;

            const result = await updateModelMetadata();
            await loadMetadataUpdatedAt();
            alert.success(
                result.status === 'unchanged'
                    ? t('settings.dataManagement.modelDatabaseAlreadyUpToDate')
                    : t('settings.dataManagement.modelDatabaseUpdated')
            );
        } catch (error) {
            log.error('Failed to update model metadata:', error);
            alert.error(t('settings.dataManagement.updateModelDatabaseFailed'));
        } finally {
            isLoading.value = false;
        }
    };
</script>

<template>
    <div class="settings-page">
        <div class="settings-section-stack">
            <header class="settings-page-header">
                <h1 class="settings-page-title">{{ t('settings.nav.dataManagement.label') }}</h1>
            </header>

            <section class="space-y-4">
                <h2 class="settings-section-title">{{ t('settings.dataManagement.stats') }}</h2>

                <div class="settings-row-group p-4" data-settings-search-target="data-stats">
                    <div class="grid grid-cols-3 gap-3">
                        <div class="rounded-control bg-neutral-50/80 p-4 text-center">
                            <div class="text-lg font-semibold text-neutral-950">
                                {{ stats.sessions }}
                            </div>
                            <div class="mt-1.5 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.sessions') }}
                            </div>
                        </div>
                        <div class="rounded-control bg-neutral-50/80 p-4 text-center">
                            <div class="text-lg font-semibold text-neutral-950">
                                {{ stats.messages }}
                            </div>
                            <div class="mt-1.5 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.messages') }}
                            </div>
                        </div>
                        <div class="rounded-control bg-neutral-50/80 p-4 text-center">
                            <div class="text-lg font-semibold text-neutral-950">
                                {{ stats.sessionTurns }}
                            </div>
                            <div class="mt-1.5 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.sessionTurns') }}
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <StorageSection
                ref="storageSection"
                :disabled="isLoading"
                @busy-change="storageBusy = $event"
                @cleaned="loadStats"
            />

            <section class="space-y-4">
                <h2 class="settings-section-title">{{ t('settings.dataManagement.history') }}</h2>
                <div
                    data-testid="settings-data-history-list"
                    class="settings-row-group divide-y divide-neutral-200/70"
                >
                    <div
                        data-testid="settings-data-history-item"
                        data-settings-search-target="data-clear-sessions"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">
                                {{ t('settings.dataManagement.clearAllSessions') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.clearAllSessionsDescription') }}
                            </div>
                        </div>
                        <Button
                            variant="danger"
                            :disabled="dataActionsDisabled || stats.sessions === 0"
                            @click="handleClearSessions"
                        >
                            {{ t('common.clear') }}
                        </Button>
                    </div>

                    <div
                        data-testid="settings-data-history-item"
                        data-settings-search-target="data-clear-messages"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">
                                {{ t('settings.dataManagement.clearAllMessages') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.clearAllMessagesDescription') }}
                            </div>
                        </div>
                        <Button
                            variant="danger"
                            :disabled="dataActionsDisabled || stats.messages === 0"
                            @click="handleClearMessages"
                        >
                            {{ t('common.clear') }}
                        </Button>
                    </div>

                    <div
                        data-testid="settings-data-history-item"
                        data-settings-search-target="data-clear-turns"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">
                                {{ t('settings.dataManagement.clearSessionTurns') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.clearSessionTurnsDescription') }}
                            </div>
                        </div>
                        <Button
                            variant="danger"
                            :disabled="dataActionsDisabled || stats.sessionTurns === 0"
                            @click="handleClearSessionTurns"
                        >
                            {{ t('common.clear') }}
                        </Button>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <div>
                    <h2 class="settings-section-title">
                        {{ t('settings.dataManagement.retention.title') }}
                    </h2>
                    <p class="settings-section-description">
                        {{ t('settings.dataManagement.retention.description') }}
                    </p>
                </div>

                <div class="settings-row-group">
                    <div
                        data-testid="settings-data-retention-row"
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">
                                {{ t('settings.dataManagement.retention.label') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.retention.hint') }}
                            </div>
                        </div>
                        <div class="ml-auto w-[180px]">
                            <CustomSelect
                                :model-value="settingsStore.usageDetailRetentionDays"
                                :options="retentionOptions"
                                :disabled="savingRetention || dataActionsDisabled"
                                trigger-test-id="settings-data-retention-trigger"
                                @update:model-value="saveRetention"
                            />
                        </div>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <h2 class="settings-section-title">
                    {{ t('settings.dataManagement.dataUpdates') }}
                </h2>
                <div class="settings-row-group">
                    <div
                        data-testid="settings-data-plain-row"
                        data-settings-search-target="model-database"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">
                                {{ t('settings.dataManagement.modelDatabase') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.modelDatabaseDescription') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ modelMetadataUpdatedText }}
                            </div>
                        </div>
                        <Button
                            variant="strong"
                            :disabled="dataActionsDisabled"
                            @click="handleUpdateModelMetadata"
                        >
                            {{ t('common.update') }}
                        </Button>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <h2 class="settings-section-title">
                    {{ t('settings.dataManagement.settingsBackup') }}
                </h2>
                <div class="settings-row-group divide-y divide-neutral-200/70">
                    <div
                        data-testid="settings-data-plain-row"
                        data-settings-search-target="export-settings"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">
                                {{ t('settings.dataManagement.exportSettings') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.exportSettingsDescription') }}
                            </div>
                        </div>
                        <Button
                            variant="strong"
                            :disabled="dataActionsDisabled"
                            @click="chooseBackupScope('export')"
                        >
                            {{ t('common.export') }}
                        </Button>
                    </div>

                    <div
                        data-testid="settings-data-plain-row"
                        data-settings-search-target="import-settings"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">
                                {{ t('settings.dataManagement.importSettings') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.importSettingsDescription') }}
                            </div>
                        </div>
                        <Button
                            variant="strong"
                            :disabled="dataActionsDisabled"
                            @click="chooseBackupScope('import')"
                        >
                            {{ t('common.import') }}
                        </Button>
                    </div>
                </div>
            </section>

            <DiagnosticsSection />

            <AnalyticsSection />

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
