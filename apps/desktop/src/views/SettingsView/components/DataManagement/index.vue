<script setup lang="ts">
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import {
        databaseBackup,
        type ImportMode,
        isDatabaseBackupCancelledError,
    } from '@database/backup';
    import {
        countMessages,
        countSessions,
        countSessionTurns,
        deleteAllMessages,
        deleteAllSessions,
        deleteAllSessionTurns,
        getStatistic,
    } from '@database/queries';
    import { setMeta } from '@database/queries/touchaiMeta';
    import { MetaKey, StatisticKey } from '@database/schema';
    import { relaunch } from '@tauri-apps/plugin-process';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { t, tt } from '@/i18n';
    import { formatDateTime } from '@/i18n/format';
    import { updateModelMetadata } from '@/services/AgentService/infrastructure/modelMetadata';
    import { serializeImportSuccessStartupPayload } from '@/services/StartupService';

    defineOptions({
        name: 'SettingsDataManagementSection',
    });

    import ImportModeDialog from './components/ImportModeDialog.vue';
    import ProgressDialog from './components/ProgressDialog.vue';

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
    const showImportModeDialog = ref(false);

    // Progress Dialog states
    const showProgressDialog = ref(false);
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
        modelMetadataLastUpdatedAt.value = value;
    };

    const loadStats = async () => {
        try {
            const [sessionsCount, messagesCount, sessionTurnsCount] = await Promise.all([
                countSessions(),
                countMessages(),
                countSessionTurns(),
            ]);

            stats.value = {
                sessions: sessionsCount,
                messages: messagesCount,
                sessionTurns: sessionTurnsCount,
            };
        } catch (error) {
            console.error('Failed to load stats:', error);
            alert.error(t('settings.dataManagement.loadStatsFailed'));
        }
    };

    onMounted(async () => {
        await Promise.all([loadStats(), loadMetadataUpdatedAt()]);
    });

    onUnmounted(() => {
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

        if (confirmed) {
            try {
                isLoading.value = true;
                await deleteAllSessions();
                alert.success(t('settings.dataManagement.clearSessionsSuccess'));
                await loadStats();
            } catch (error) {
                console.error('Failed to clear sessions:', error);
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

        if (confirmed) {
            try {
                isLoading.value = true;
                await deleteAllMessages();
                alert.success(t('settings.dataManagement.clearMessagesSuccess'));
                await loadStats();
            } catch (error) {
                console.error('Failed to clear messages:', error);
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

        if (confirmed) {
            try {
                isLoading.value = true;
                await deleteAllSessionTurns();
                alert.success(t('settings.dataManagement.clearSessionTurnsSuccess'));
                await loadStats();
            } catch (error) {
                console.error('Failed to clear session turns:', error);
                alert.error(t('settings.dataManagement.clearSessionTurnsFailed'));
            } finally {
                isLoading.value = false;
            }
        }
    };

    // 更新进度弹窗
    const updateProgress = (message: string, progress: number = 0) => {
        progressMessage.value = translateDataManagementMessage(message);
        progressValue.value = progress;
    };

    const handleExportSettings = async () => {
        try {
            isLoading.value = true;
            progressTitle.value = t('settings.dataManagement.exporting');
            progressStatus.value = 'loading';

            const exportedPath = await databaseBackup.exportDatabase((msg, prog) => {
                if (!showProgressDialog.value) {
                    showProgressDialog.value = true;
                }
                updateProgress(msg, prog);
            });

            showProgressDialog.value = false;
            alert.success(t('settings.dataManagement.exported', { path: exportedPath }));
        } catch (error) {
            console.error('Failed to export settings:', error);
            showProgressDialog.value = false;

            const message =
                error instanceof Error ? error.message : t('settings.dataManagement.exportFailed');
            if (!isDatabaseBackupCancelledError(error)) {
                alert.error(translateDataManagementMessage(message));
            }
        } finally {
            isLoading.value = false;
        }
    };

    const openImportModeDialog = () => {
        showImportModeDialog.value = true;
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
                relaunch();
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

            const result = await databaseBackup.importDatabase(mode, (msg, prog) => {
                if (!showProgressDialog.value) {
                    showProgressDialog.value = true;
                }
                updateProgress(msg, prog);
            });

            if (!result.sourcePath) {
                showProgressDialog.value = false;
                return;
            }

            // 保存源数据而不是当前语言文案；重启后按导入后的语言显示通知。
            await setMeta({
                key: MetaKey.IMPORT_SUCCESS,
                value: serializeImportSuccessStartupPayload(result.importMode),
            });

            // 开始重启倒计时
            await startRestartCountdown();
        } catch (error) {
            console.error('Failed to import settings:', error);

            showProgressDialog.value = false;

            const message =
                error instanceof Error ? error.message : t('settings.dataManagement.importFailed');
            if (!isDatabaseBackupCancelledError(error)) {
                alert.error(translateDataManagementMessage(message));
            }
        } finally {
            isLoading.value = false;
        }
    };

    const handleUpdateModelMetadata = async () => {
        try {
            isLoading.value = true;

            await updateModelMetadata();
            await loadMetadataUpdatedAt();
            alert.success(t('settings.dataManagement.modelDatabaseUpdated'));
        } catch (error) {
            console.error('Failed to update model metadata:', error);
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

                <div class="settings-row-group p-4">
                    <div class="grid grid-cols-3 gap-3">
                        <div class="rounded-[10px] bg-neutral-50/80 p-4 text-center">
                            <div class="text-lg font-semibold text-neutral-950">
                                {{ stats.sessions }}
                            </div>
                            <div class="mt-1.5 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.sessions') }}
                            </div>
                        </div>
                        <div class="rounded-[10px] bg-neutral-50/80 p-4 text-center">
                            <div class="text-lg font-semibold text-neutral-950">
                                {{ stats.messages }}
                            </div>
                            <div class="mt-1.5 text-xs text-neutral-500">
                                {{ t('settings.dataManagement.messages') }}
                            </div>
                        </div>
                        <div class="rounded-[10px] bg-neutral-50/80 p-4 text-center">
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
                        <button
                            class="settings-button-danger"
                            :disabled="isLoading || stats.sessions === 0"
                            @click="handleClearSessions"
                        >
                            {{ t('common.clear') }}
                        </button>
                    </div>

                    <div
                        data-testid="settings-data-history-item"
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
                        <button
                            class="settings-button-danger"
                            :disabled="isLoading || stats.messages === 0"
                            @click="handleClearMessages"
                        >
                            {{ t('common.clear') }}
                        </button>
                    </div>

                    <div
                        data-testid="settings-data-history-item"
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
                        <button
                            class="settings-button-danger"
                            :disabled="isLoading || stats.sessionTurns === 0"
                            @click="handleClearSessionTurns"
                        >
                            {{ t('common.clear') }}
                        </button>
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
                        <button
                            class="settings-button-primary"
                            :disabled="isLoading"
                            @click="handleUpdateModelMetadata"
                        >
                            {{ t('common.update') }}
                        </button>
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
                        <button
                            class="settings-button-primary"
                            :disabled="isLoading"
                            @click="handleExportSettings"
                        >
                            {{ t('common.export') }}
                        </button>
                    </div>

                    <div
                        data-testid="settings-data-plain-row"
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
                        <button
                            class="settings-button-primary"
                            :disabled="isLoading"
                            @click="openImportModeDialog"
                        >
                            {{ t('common.import') }}
                        </button>
                    </div>
                </div>
            </section>

            <ImportModeDialog
                v-if="showImportModeDialog"
                :is-loading="isLoading"
                @close="showImportModeDialog = false"
                @select="handleImportSettings"
            />

            <ProgressDialog
                v-if="showProgressDialog"
                :title="progressTitle"
                :message="progressMessage"
                :progress="progressValue"
                :status="progressStatus"
            />
        </div>
    </div>
</template>
