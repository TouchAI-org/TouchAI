<script setup lang="ts">
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import { databaseBackup, type ImportMode } from '@database/backup';
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

    import { updateModelMetadata } from '@/services/AgentService/infrastructure/modelMetadata';

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
            return '最近更新：暂无记录';
        }

        const date = new Date(modelMetadataLastUpdatedAt.value);
        if (Number.isNaN(date.getTime())) {
            return `最近更新：${modelMetadataLastUpdatedAt.value}`;
        }

        return `最近更新：${date.toLocaleString('zh-CN', {
            hour12: false,
        })}`;
    });

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
            alert.error('加载统计数据失败');
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
            title: '清除所有对话历史',
            message: '此操作将删除所有对话会话及其消息，且无法恢复。确定要继续吗？',
            type: 'danger',
        });

        if (confirmed) {
            try {
                isLoading.value = true;
                await deleteAllSessions();
                alert.success('已成功删除所有会话');
                await loadStats();
            } catch (error) {
                console.error('Failed to clear sessions:', error);
                alert.error('清除对话历史失败');
            } finally {
                isLoading.value = false;
            }
        }
    };

    const handleClearMessages = async () => {
        const confirmed = await confirm({
            title: '清除所有消息',
            message: '此操作将删除所有消息记录，但保留会话。确定要继续吗？',
            type: 'danger',
        });

        if (confirmed) {
            try {
                isLoading.value = true;
                await deleteAllMessages();
                alert.success('已成功删除所有消息');
                await loadStats();
            } catch (error) {
                console.error('Failed to clear messages:', error);
                alert.error('清除消息失败');
            } finally {
                isLoading.value = false;
            }
        }
    };

    const handleClearSessionTurns = async () => {
        const confirmed = await confirm({
            title: '清除对话记录',
            message: '此操作将删除所有对话记录。确定要继续吗？',
            type: 'danger',
        });

        if (confirmed) {
            try {
                isLoading.value = true;
                await deleteAllSessionTurns();
                alert.success('已成功删除所有对话记录');
                await loadStats();
            } catch (error) {
                console.error('Failed to clear session turns:', error);
                alert.error('清除对话记录失败');
            } finally {
                isLoading.value = false;
            }
        }
    };

    // 更新进度弹窗
    const updateProgress = (message: string, progress: number = 0) => {
        progressMessage.value = message;
        progressValue.value = progress;
    };

    const handleExportSettings = async () => {
        try {
            isLoading.value = true;
            progressTitle.value = '正在导出';
            progressStatus.value = 'loading';

            const exportedPath = await databaseBackup.exportDatabase((msg, prog) => {
                if (!showProgressDialog.value) {
                    showProgressDialog.value = true;
                }
                updateProgress(msg, prog);
            });

            showProgressDialog.value = false;
            alert.success(`数据库已导出：${exportedPath}`);
        } catch (error) {
            console.error('Failed to export settings:', error);
            showProgressDialog.value = false;

            const message = error instanceof Error ? error.message : '导出设置失败';
            if (message !== '已取消导出') {
                alert.error(message);
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
        progressTitle.value = '导入成功';
        restartCountdown.value = 3;
        progressMessage.value = `应用即将在 ${restartCountdown.value} 秒后重启以应用更改...`;

        countdownTimer = setInterval(() => {
            if (restartCountdown.value !== null && restartCountdown.value > 0) {
                restartCountdown.value--;
                progressMessage.value = `应用即将在 ${restartCountdown.value} 秒后重启以应用更改...`;
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
            progressTitle.value = '正在导入';
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

            const modeText =
                result.importMode === 'chat_only' ? '仅导入对话数据' : '覆盖设置，差量导入对话数据';

            let message = `数据导入成功（${modeText}）`;

            // 保存成功消息到元数据，以便重启后显示
            await setMeta({ key: MetaKey.IMPORT_SUCCESS, value: message });

            // 开始重启倒计时
            await startRestartCountdown();
        } catch (error) {
            console.error('Failed to import settings:', error);

            showProgressDialog.value = false;

            const message = error instanceof Error ? error.message : '导入设置失败';
            if (message !== '已取消导入') {
                alert.error(message);
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
            alert.success('大模型数据库已更新');
        } catch (error) {
            console.error('Failed to update model metadata:', error);
            alert.error('更新大模型数据库失败');
        } finally {
            isLoading.value = false;
        }
    };
</script>

<template>
    <div class="settings-page">
        <div class="settings-section-stack">
            <header class="settings-page-header">
                <h1 class="settings-page-title">数据管理</h1>
            </header>

            <section class="space-y-4">
                <h2 class="settings-section-title">数据统计</h2>

                <div class="settings-row-group p-4">
                    <div class="grid grid-cols-3 gap-3">
                        <div class="rounded-[10px] bg-neutral-50/80 p-4 text-center">
                            <div class="text-lg font-semibold text-neutral-950">
                                {{ stats.sessions }}
                            </div>
                            <div class="mt-1.5 text-xs text-neutral-500">对话会话数</div>
                        </div>
                        <div class="rounded-[10px] bg-neutral-50/80 p-4 text-center">
                            <div class="text-lg font-semibold text-neutral-950">
                                {{ stats.messages }}
                            </div>
                            <div class="mt-1.5 text-xs text-neutral-500">消息总数</div>
                        </div>
                        <div class="rounded-[10px] bg-neutral-50/80 p-4 text-center">
                            <div class="text-lg font-semibold text-neutral-950">
                                {{ stats.sessionTurns }}
                            </div>
                            <div class="mt-1.5 text-xs text-neutral-500">对话轮次数</div>
                        </div>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <h2 class="settings-section-title">历史记录</h2>
                <div
                    data-testid="settings-data-history-list"
                    class="settings-row-group divide-y divide-neutral-200/70"
                >
                    <div
                        data-testid="settings-data-history-item"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">清除所有对话历史</div>
                            <div class="mt-1 text-xs text-neutral-500">
                                删除所有会话及其消息，此操作不可恢复
                            </div>
                        </div>
                        <button
                            class="settings-button-danger"
                            :disabled="isLoading || stats.sessions === 0"
                            @click="handleClearSessions"
                        >
                            清除
                        </button>
                    </div>

                    <div
                        data-testid="settings-data-history-item"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">清除所有消息</div>
                            <div class="mt-1 text-xs text-neutral-500">
                                删除所有消息记录，但保留会话
                            </div>
                        </div>
                        <button
                            class="settings-button-danger"
                            :disabled="isLoading || stats.messages === 0"
                            @click="handleClearMessages"
                        >
                            清除
                        </button>
                    </div>

                    <div
                        data-testid="settings-data-history-item"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">清除对话记录</div>
                            <div class="mt-1 text-xs text-neutral-500">删除所有对话历史记录</div>
                        </div>
                        <button
                            class="settings-button-danger"
                            :disabled="isLoading || stats.sessionTurns === 0"
                            @click="handleClearSessionTurns"
                        >
                            清除
                        </button>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <h2 class="settings-section-title">数据更新</h2>
                <div class="settings-row-group">
                    <div
                        data-testid="settings-data-plain-row"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">大模型数据库</div>
                            <div class="mt-1 text-xs text-neutral-500">
                                从远程数据库同步大模型能力数据
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
                            更新
                        </button>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <h2 class="settings-section-title">设置备份</h2>
                <div class="settings-row-group divide-y divide-neutral-200/70">
                    <div
                        data-testid="settings-data-plain-row"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">导出设置</div>
                            <div class="mt-1 text-xs text-neutral-500">
                                将当前数据导出为 .db 数据库备份文件
                            </div>
                        </div>
                        <button
                            class="settings-button-primary"
                            :disabled="isLoading"
                            @click="handleExportSettings"
                        >
                            导出
                        </button>
                    </div>

                    <div
                        data-testid="settings-data-plain-row"
                        class="flex items-center justify-between gap-5 rounded-none bg-transparent px-5 py-4"
                    >
                        <div>
                            <div class="text-sm font-medium text-neutral-950">导入设置</div>
                            <div class="mt-1 text-xs text-neutral-500">
                                从 .db 备份文件恢复数据（将先询问导入模式）
                            </div>
                        </div>
                        <button
                            class="settings-button-primary"
                            :disabled="isLoading"
                            @click="openImportModeDialog"
                        >
                            导入
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
