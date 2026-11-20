<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import { Button } from '@components/ui/button';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import { useStateMachine } from 'reka-ui';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { log } from '@/app/api/diagnostics';
    import { useModelMetadataApi } from '@/app/api/models/metadata';
    import {
        type DataStats,
        type ImportMode,
        isDatabaseBackupCancelledError,
        useDataManagementApi,
    } from '@/app/api/settings/dataManagement';
    import { t, tt } from '@/i18n';
    import { formatDateTime } from '@/i18n/format';
    import { useSettingsStore } from '@/stores/settings';

    defineOptions({
        name: 'SettingsDataManagementSection',
    });

    import AnalyticsSection from './components/AnalyticsSection.vue';
    import DiagnosticsSection from './components/DiagnosticsSection.vue';
    import ImportModeDialog from './components/ImportModeDialog.vue';
    import ProgressDialog from './components/ProgressDialog.vue';

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
    const modelMetadataLastUpdatedAt = ref<string | null>(null);
    let countdownTimer: ReturnType<typeof setInterval> | null = null;

    const alert = useAlert();
    const { confirm } = useConfirm();
    const settingsStore = useSettingsStore();
    const metadata = useModelMetadataApi();
    const data = useDataManagementApi();
    const lifetime = new AbortController();

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
            if (lifetime.signal.aborted) return;
            alert.success(t('settings.dataManagement.retention.saved'));
        } catch (error) {
            if (lifetime.signal.aborted) return;
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
        const value = await metadata.readLastUpdatedAt({ signal: lifetime.signal });
        if (lifetime.signal.aborted) return;
        modelMetadataLastUpdatedAt.value = value;
    };

    const loadStats = async () => {
        try {
            const value = await data.stats();
            if (lifetime.signal.aborted) return;
            stats.value = value;
        } catch (error) {
            if (lifetime.signal.aborted) return;
            log.error('Failed to load stats:', error);
            alert.error(t('settings.dataManagement.loadStatsFailed'));
        }
    };

    onMounted(async () => {
        await Promise.all([
            loadStats(),
            loadMetadataUpdatedAt().catch((error: unknown) => {
                if (!lifetime.signal.aborted)
                    log.warn('[DataManagement] Model metadata freshness unavailable', error);
            }),
        ]);
    });

    onUnmounted(() => {
        lifetime.abort();
        importDialog.dispatch('dispose');
        progressDialog.dispatch('dispose');
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
    });

    const handleClearSessions = async () => {
        const confirmed = await confirm({
            title: t('settings.dataManagement.clearAllSessions'),
            message: t('settings.dataManagement.clearAllSessionsConfirm'),
            type: 'danger',
        });

        if (confirmed && !lifetime.signal.aborted) {
            try {
                isLoading.value = true;
                await data.clear('sessions');
                if (lifetime.signal.aborted) return;
                alert.success(t('settings.dataManagement.clearSessionsSuccess'));
                await loadStats();
            } catch (error) {
                if (lifetime.signal.aborted) return;
                log.error('Failed to clear sessions:', error);
                alert.error(t('settings.dataManagement.clearSessionsFailed'));
            } finally {
                isLoading.value = false;
            }
        }
    };

    const handleClearMessages = async () => {
        const confirmed = await confirm({
            title: t('settings.dataManagement.clearAllMessages'),
            message: t('settings.dataManagement.clearAllMessagesConfirm'),
            type: 'danger',
        });

        if (confirmed && !lifetime.signal.aborted) {
            try {
                isLoading.value = true;
                await data.clear('messages');
                if (lifetime.signal.aborted) return;
                alert.success(t('settings.dataManagement.clearMessagesSuccess'));
                await loadStats();
            } catch (error) {
                if (lifetime.signal.aborted) return;
                log.error('Failed to clear messages:', error);
                alert.error(t('settings.dataManagement.clearMessagesFailed'));
            } finally {
                isLoading.value = false;
            }
        }
    };

    const handleClearSessionTurns = async () => {
        const confirmed = await confirm({
            title: t('settings.dataManagement.clearSessionTurns'),
            message: t('settings.dataManagement.clearSessionTurnsConfirm'),
            type: 'danger',
        });

        if (confirmed && !lifetime.signal.aborted) {
            try {
                isLoading.value = true;
                await data.clear('sessionTurns');
                if (lifetime.signal.aborted) return;
                alert.success(t('settings.dataManagement.clearSessionTurnsSuccess'));
                await loadStats();
            } catch (error) {
                if (lifetime.signal.aborted) return;
                log.error('Failed to clear session turns:', error);
                alert.error(t('settings.dataManagement.clearSessionTurnsFailed'));
            } finally {
                isLoading.value = false;
            }
        }
    };

    // 更新进度弹窗
    const updateProgress = (message: string, progress: number = 0) => {
        if (lifetime.signal.aborted) return;
        progressMessage.value = translateDataManagementMessage(message);
        progressValue.value = progress;
    };

    const handleExportSettings = async () => {
        try {
            isLoading.value = true;
            progressTitle.value = t('settings.dataManagement.exporting');
            progressStatus.value = 'loading';

            const exportedPath = await data.exportDatabase((msg, prog) => {
                if (lifetime.signal.aborted) return;
                if (!showProgressDialog.value) {
                    showProgressDialog.value = true;
                }
                updateProgress(msg, prog);
            });

            if (lifetime.signal.aborted) return;
            showProgressDialog.value = false;
            alert.success(t('settings.dataManagement.exported', { path: exportedPath }));
        } catch (error) {
            if (lifetime.signal.aborted) return;
            log.error('Failed to export settings:', error);
            showProgressDialog.value = false;

            if (!isDatabaseBackupCancelledError(error)) {
                alert.error(t('settings.dataManagement.exportFailed'));
            }
        } finally {
            isLoading.value = false;
        }
    };

    const openImportModeDialog = () => {
        showImportModeDialog.value = true;
    };

    const handleImportModeDialogClosed = () => {
        importDialog.dispatch('closed');
    };

    const handleProgressDialogClosed = () => {
        progressDialog.dispatch('closed');
    };

    const startRestartCountdown = async () => {
        if (lifetime.signal.aborted) return;
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
                void data.relaunch().catch((error: unknown) => {
                    if (lifetime.signal.aborted) return;
                    log.error('[DataManagement] Restart failed', error);
                    alert.error(t('settings.dataManagement.importFailed'));
                });
            }
        }, 1000);
    };

    const handleImportSettings = async (mode: ImportMode) => {
        showImportModeDialog.value = false;

        try {
            isLoading.value = true;
            progressTitle.value = t('settings.dataManagement.importing');
            progressStatus.value = 'loading';
            restartCountdown.value = null;

            const result = await data.importDatabase(mode, (msg, prog) => {
                if (lifetime.signal.aborted) return;
                if (!showProgressDialog.value) {
                    showProgressDialog.value = true;
                }
                updateProgress(msg, prog);
            });

            if (lifetime.signal.aborted) return;
            if (!result) {
                showProgressDialog.value = false;
                return;
            }

            // 开始重启倒计时
            await startRestartCountdown();
        } catch (error) {
            if (lifetime.signal.aborted) return;
            log.error('Failed to import settings:', error);

            showProgressDialog.value = false;

            if (!isDatabaseBackupCancelledError(error)) {
                alert.error(t('settings.dataManagement.importFailed'));
            }
        } finally {
            isLoading.value = false;
        }
    };

    const handleUpdateModelMetadata = async () => {
        try {
            isLoading.value = true;

            const result = await metadata.refresh({ force: true, signal: lifetime.signal });
            await loadMetadataUpdatedAt();
            if (lifetime.signal.aborted) return;
            alert.success(
                result.status === 'unchanged'
                    ? t('settings.dataManagement.modelDatabaseAlreadyUpToDate')
                    : t('settings.dataManagement.modelDatabaseUpdated')
            );
        } catch (error) {
            if (lifetime.signal.aborted) return;
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
                            :disabled="isLoading || stats.sessions === 0"
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
                            :disabled="isLoading || stats.messages === 0"
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
                            :disabled="isLoading || stats.sessionTurns === 0"
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
                                :disabled="savingRetention"
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
                            :disabled="isLoading"
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
                            :disabled="isLoading"
                            @click="handleExportSettings"
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
                            :disabled="isLoading"
                            @click="openImportModeDialog"
                        >
                            {{ t('common.import') }}
                        </Button>
                    </div>
                </div>
            </section>

            <DiagnosticsSection />

            <AnalyticsSection />

            <ImportModeDialog
                v-if="isImportModeDialogMounted"
                :open="showImportModeDialog"
                :is-loading="isLoading"
                @close="showImportModeDialog = false"
                @select="handleImportSettings"
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
