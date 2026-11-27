<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import DialogShell from '@components/DialogShell.vue';
    import EmptyState from '@components/EmptyState.vue';
    import LoadingState from '@components/LoadingState.vue';
    import { Button } from '@components/ui/button';
    import { Switch } from '@components/ui/switch';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { useScrollFade } from '@composables/useScrollFade';
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

    import { log } from '@/app/api/diagnostics';
    import {
        type ModelWithProvider,
        useModelAdministrationApi,
    } from '@/app/api/models/administration';
    import {
        type ScheduledTask,
        type ScheduledTaskDraft,
        type ScheduledTaskRun,
        useScheduledTasksApi,
    } from '@/app/api/scheduler/administration';
    import { locale, t } from '@/i18n';

    import { describeTrigger, formatDateTime, outcomeLabel, reasonLabel } from './presentation';
    import ScheduledTaskFormDialog from './ScheduledTaskFormDialog.vue';

    defineOptions({
        name: 'SettingsScheduledTasksSection',
    });

    const api = useScheduledTasksApi();
    const modelsApi = useModelAdministrationApi();
    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const tasks = ref<ScheduledTask[]>([]);
    const models = ref<ModelWithProvider[]>([]);
    const runs = ref<ScheduledTaskRun[]>([]);
    const selectedId = ref<string | null>(null);
    const loading = ref(true);
    const runsLoading = ref(false);
    const saving = ref(false);
    const deleting = ref(false);
    const formOpen = ref(false);
    const deleteOpen = ref(false);
    const editingTask = ref<ScheduledTask | undefined>();
    const deletingTask = ref<ScheduledTask | undefined>();
    const contentRef = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(contentRef);
    const { scrollFadeStyle } = useScrollFade(contentRef);
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const selectedTask = computed(
        () => tasks.value.find((task) => task.id === selectedId.value) ?? null
    );
    const hasActiveRun = computed(() => runs.value.some((run) => run.outcome === null));

    function modelLabel(task: ScheduledTask): string {
        if (!task.modelId || !task.providerId) {
            return t('settings.scheduledTasks.defaultModel');
        }
        const model = models.value.find(
            (candidate) =>
                candidate.model_id === task.modelId && candidate.provider_id === task.providerId
        );
        return model ? `${model.provider_name} / ${model.name}` : task.modelId;
    }

    function nextRunLabel(task: ScheduledTask): string {
        return task.nextRunAt === null
            ? t('settings.scheduledTasks.noNextRun')
            : formatDateTime(task.nextRunAt, task.timezone, locale.value);
    }

    function lastRunLabel(task: ScheduledTask): string {
        return task.lastRunAt === null
            ? t('settings.scheduledTasks.never')
            : formatDateTime(task.lastRunAt, task.timezone, locale.value);
    }

    function timeLabel(timestamp: number | null, task: ScheduledTask): string {
        return timestamp === null
            ? t('settings.scheduledTasks.reason.none')
            : formatDateTime(timestamp, task.timezone, locale.value);
    }

    async function loadRuns(taskId: string, preserveRuns = false) {
        runsLoading.value = true;
        if (!preserveRuns) runs.value = [];
        try {
            const nextRuns = await api.runs(taskId);
            if (selectedId.value === taskId) runs.value = nextRuns;
        } catch (error) {
            log.error('[ScheduledTasksView] Failed to load run history:', error);
            alertMessage.value?.error(t('settings.scheduledTasks.loadFailed'), 6000);
        } finally {
            if (selectedId.value === taskId) runsLoading.value = false;
        }
    }

    async function loadTasks(options: { preserveSelection?: boolean } = {}) {
        if (!options.preserveSelection) loading.value = true;
        try {
            const nextTasks = await api.list();
            tasks.value = nextTasks;
            const nextSelectedId =
                selectedId.value && nextTasks.some((task) => task.id === selectedId.value)
                    ? selectedId.value
                    : (nextTasks[0]?.id ?? null);
            selectedId.value = nextSelectedId;
            if (nextSelectedId) await loadRuns(nextSelectedId, options.preserveSelection);
            else runs.value = [];
        } catch (error) {
            log.error('[ScheduledTasksView] Failed to load schedules:', error);
            alertMessage.value?.error(t('settings.scheduledTasks.loadFailed'), 6000);
            tasks.value = [];
            runs.value = [];
            selectedId.value = null;
        } finally {
            loading.value = false;
        }
    }

    async function loadModels() {
        try {
            models.value = await modelsApi.findModelsWithProvider();
        } catch (error) {
            log.warn('[ScheduledTasksView] Could not load model options:', error);
            models.value = [];
        }
    }

    function selectTask(task: ScheduledTask) {
        if (selectedId.value === task.id) return;
        selectedId.value = task.id;
        void loadRuns(task.id);
    }

    function openCreate() {
        editingTask.value = undefined;
        formOpen.value = true;
    }

    function openEdit() {
        editingTask.value = selectedTask.value ?? undefined;
        formOpen.value = true;
    }

    async function saveTask(input: ScheduledTaskDraft) {
        saving.value = true;
        try {
            const saved = editingTask.value
                ? await api.update(editingTask.value.id, input)
                : await api.create(input);
            if (!saved) throw new Error('SCHEDULED_TASK_NOT_FOUND');
            formOpen.value = false;
            selectedId.value = saved.id;
            await loadTasks({ preserveSelection: true });
            alertMessage.value?.success(t('common.saved'), 3000);
        } catch (error) {
            log.error('[ScheduledTasksView] Failed to save schedule:', error);
            alertMessage.value?.error(t('settings.scheduledTasks.saveFailed'), 6000);
        } finally {
            saving.value = false;
        }
    }

    async function toggleTask(task: ScheduledTask, enabled: boolean) {
        try {
            const updated = await api.update(task.id, { enabled });
            if (!updated) throw new Error('SCHEDULED_TASK_NOT_FOUND');
            tasks.value = tasks.value.map((candidate) =>
                candidate.id === updated.id ? updated : candidate
            );
        } catch (error) {
            log.error('[ScheduledTasksView] Failed to toggle schedule:', error);
            alertMessage.value?.error(t('settings.scheduledTasks.toggleFailed'), 6000);
        }
    }

    function requestDelete() {
        if (!selectedTask.value) return;
        deletingTask.value = selectedTask.value;
        deleteOpen.value = true;
    }

    async function confirmDelete() {
        if (!deletingTask.value) return;
        deleting.value = true;
        try {
            const deleted = await api.remove(deletingTask.value.id);
            if (!deleted) throw new Error('SCHEDULED_TASK_NOT_FOUND');
            deleteOpen.value = false;
            deletingTask.value = undefined;
            selectedId.value = null;
            await loadTasks();
        } catch (error) {
            log.error('[ScheduledTasksView] Failed to delete schedule:', error);
            alertMessage.value?.error(t('settings.scheduledTasks.deleteFailed'), 6000);
        } finally {
            deleting.value = false;
        }
    }

    function refreshIfVisible() {
        if (disposed || document.visibilityState !== 'visible') return;
        void loadTasks({ preserveSelection: true });
    }

    onMounted(() => {
        void Promise.all([loadTasks(), loadModels()]);
        refreshTimer = setInterval(refreshIfVisible, 15_000);
    });

    onBeforeUnmount(() => {
        disposed = true;
        if (refreshTimer !== null) clearInterval(refreshTimer);
        refreshTimer = null;
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div class="flex h-full min-h-0 bg-surface-floating" data-testid="settings-scheduled-tasks">
        <aside
            class="flex w-72 shrink-0 flex-col border-r border-border-subtle bg-surface-sunken/40"
        >
            <div class="flex items-center justify-between px-4 py-3">
                <div>
                    <h1 class="text-reading font-semibold text-text-primary">
                        {{ t('settings.scheduledTasks.title') }}
                    </h1>
                </div>
                <Button size="sm" @click="openCreate">
                    {{ t('settings.scheduledTasks.add') }}
                </Button>
            </div>

            <div
                ref="contentRef"
                class="settings-scrollbar settings-scroll-fade min-h-0 flex-1 overflow-y-auto px-2 pb-3"
                :style="scrollFadeStyle"
            >
                <LoadingState v-if="loading" variant="brand" fill="min" />
                <EmptyState
                    v-else-if="tasks.length === 0"
                    :title="t('settings.scheduledTasks.emptyTitle')"
                    :description="t('settings.scheduledTasks.emptyDescription')"
                    icon="history"
                />
                <div v-else class="space-y-1">
                    <div
                        v-for="task in tasks"
                        :key="task.id"
                        class="flex w-full items-start gap-2 rounded-control border px-3 py-2.5 transition-colors"
                        :class="
                            task.id === selectedId
                                ? 'border-primary-300 bg-surface-floating shadow-sm'
                                : 'border-transparent hover:bg-surface-active'
                        "
                    >
                        <button
                            type="button"
                            class="min-w-0 flex-1 text-left"
                            :data-testid="`scheduled-task-row-${task.id}`"
                            @click="selectTask(task)"
                        >
                            <span class="min-w-0 truncate text-sm font-medium text-text-primary">
                                {{ task.name }}
                            </span>
                            <p class="mt-1 truncate text-xs text-muted-foreground">
                                {{
                                    task.enabled
                                        ? nextRunLabel(task)
                                        : t('settings.scheduledTasks.paused')
                                }}
                            </p>
                        </button>
                        <Switch
                            :model-value="task.enabled"
                            @update:model-value="toggleTask(task, $event)"
                        />
                    </div>
                </div>
            </div>
        </aside>

        <section class="settings-scrollbar min-w-0 flex-1 overflow-y-auto">
            <div v-if="!selectedTask" class="flex h-full items-center justify-center p-8">
                <EmptyState
                    :title="t('settings.scheduledTasks.selectTitle')"
                    :description="t('settings.scheduledTasks.selectDescription')"
                    icon="history"
                />
            </div>

            <div v-else class="space-y-6 p-6">
                <header class="flex items-start justify-between gap-4">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <h1 class="truncate text-title font-semibold text-text-primary">
                                {{ selectedTask.name }}
                            </h1>
                            <span
                                v-if="hasActiveRun"
                                class="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700"
                            >
                                {{ t('settings.scheduledTasks.active') }}
                            </span>
                            <span
                                v-else-if="!selectedTask.enabled"
                                class="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-text-secondary"
                            >
                                {{ t('settings.scheduledTasks.paused') }}
                            </span>
                        </div>
                    </div>
                    <div class="flex shrink-0 gap-2">
                        <Button variant="outline" @click="openEdit">
                            {{ t('common.edit') }}
                        </Button>
                        <Button variant="danger" @click="requestDelete">
                            {{ t('common.delete') }}
                        </Button>
                    </div>
                </header>

                <div class="rounded-card border border-border-subtle bg-surface-floating p-5">
                    <dl class="grid gap-4 sm:grid-cols-2">
                        <div>
                            <dt
                                class="text-xs font-medium tracking-wide text-muted-foreground uppercase"
                            >
                                {{ t('settings.scheduledTasks.trigger') }}
                            </dt>
                            <dd class="mt-1 text-sm text-text-primary">
                                {{ describeTrigger(selectedTask, locale) }}
                            </dd>
                        </div>
                        <div>
                            <dt
                                class="text-xs font-medium tracking-wide text-muted-foreground uppercase"
                            >
                                {{ t('settings.scheduledTasks.timezone') }}
                            </dt>
                            <dd class="mt-1 font-mono text-sm text-text-primary">
                                {{ selectedTask.timezone }}
                            </dd>
                        </div>
                        <div>
                            <dt
                                class="text-xs font-medium tracking-wide text-muted-foreground uppercase"
                            >
                                {{ t('settings.scheduledTasks.nextRun') }}
                            </dt>
                            <dd class="mt-1 text-sm text-text-primary">
                                {{ nextRunLabel(selectedTask) }}
                            </dd>
                        </div>
                        <div>
                            <dt
                                class="text-xs font-medium tracking-wide text-muted-foreground uppercase"
                            >
                                {{ t('settings.scheduledTasks.lastRun') }}
                            </dt>
                            <dd class="mt-1 text-sm text-text-primary">
                                {{ lastRunLabel(selectedTask) }}
                            </dd>
                        </div>
                        <div>
                            <dt
                                class="text-xs font-medium tracking-wide text-muted-foreground uppercase"
                            >
                                {{ t('settings.scheduledTasks.model') }}
                            </dt>
                            <dd class="mt-1 text-sm text-text-primary">
                                {{ modelLabel(selectedTask) }}
                            </dd>
                        </div>
                    </dl>
                    <div class="mt-5 border-t border-border-subtle pt-4">
                        <dt
                            class="text-xs font-medium tracking-wide text-muted-foreground uppercase"
                        >
                            {{ t('settings.scheduledTasks.prompt') }}
                        </dt>
                        <dd
                            class="mt-1 text-sm leading-6 break-words whitespace-pre-wrap text-text-primary"
                        >
                            {{ selectedTask.prompt }}
                        </dd>
                    </div>
                </div>

                <div
                    class="rounded-card border border-border-subtle bg-surface-sunken/50 px-4 py-3 text-sm text-text-secondary"
                >
                    <p>{{ t('settings.scheduledTasks.appClosedNotice') }}</p>
                    <p class="mt-1">{{ t('settings.scheduledTasks.overlapNotice') }}</p>
                </div>

                <section>
                    <div class="flex items-end justify-between gap-4">
                        <div>
                            <h2 class="text-reading font-semibold text-text-primary">
                                {{ t('settings.scheduledTasks.history') }}
                            </h2>
                            <p class="mt-1 text-xs text-muted-foreground">
                                {{ t('settings.scheduledTasks.historyDescription') }}
                            </p>
                        </div>
                    </div>

                    <LoadingState v-if="runsLoading" variant="brand" fill="min" />
                    <div
                        v-else-if="runs.length === 0"
                        class="mt-4 rounded-card border border-dashed border-border-subtle py-10 text-center text-sm text-muted-foreground"
                    >
                        {{ t('settings.scheduledTasks.noHistory') }}
                    </div>
                    <div
                        v-else
                        class="mt-4 overflow-hidden rounded-card border border-border-subtle"
                    >
                        <table class="w-full table-fixed text-left text-xs">
                            <thead class="bg-surface-sunken/70 text-muted-foreground">
                                <tr>
                                    <th class="px-3 py-2 font-medium">
                                        {{ t('settings.scheduledTasks.plannedFor') }}
                                    </th>
                                    <th class="px-3 py-2 font-medium">
                                        {{ t('settings.scheduledTasks.startedAt') }}
                                    </th>
                                    <th class="px-3 py-2 font-medium">
                                        {{ t('settings.scheduledTasks.finishedAt') }}
                                    </th>
                                    <th class="px-3 py-2 font-medium">
                                        {{ t('settings.scheduledTasks.outcome') }}
                                    </th>
                                    <th class="px-3 py-2 font-medium">
                                        {{ t('settings.scheduledTasks.details') }}
                                    </th>
                                    <th class="px-3 py-2 font-medium">
                                        {{ t('settings.scheduledTasks.conversation') }}
                                    </th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-border-subtle">
                                <tr
                                    v-for="run in runs"
                                    :key="run.id"
                                    :data-testid="`scheduled-task-run-${run.id}`"
                                >
                                    <td class="px-3 py-2 text-text-primary">
                                        {{ timeLabel(run.scheduledFor, selectedTask) }}
                                    </td>
                                    <td class="px-3 py-2 text-text-primary">
                                        {{ timeLabel(run.startedAt, selectedTask) }}
                                    </td>
                                    <td class="px-3 py-2 text-text-primary">
                                        {{ timeLabel(run.finishedAt, selectedTask) }}
                                    </td>
                                    <td class="px-3 py-2">
                                        <span
                                            class="rounded-full px-2 py-0.5"
                                            :class="
                                                run.outcome === 'failed'
                                                    ? 'bg-background-danger text-text-danger'
                                                    : run.outcome === null
                                                      ? 'bg-primary-50 text-primary-700'
                                                      : 'bg-surface-sunken text-text-primary'
                                            "
                                        >
                                            {{ outcomeLabel(run) }}
                                        </span>
                                    </td>
                                    <td
                                        class="truncate px-3 py-2 text-text-secondary"
                                        :title="reasonLabel(run)"
                                    >
                                        {{ reasonLabel(run) }}
                                    </td>
                                    <td class="px-3 py-2 font-mono text-text-secondary">
                                        <span v-if="run.sessionId">#{{ run.sessionId }}</span>
                                        <span v-if="run.turnId" class="ml-1 text-text-tertiary">
                                            T#{{ run.turnId }}
                                        </span>
                                        <span v-if="!run.sessionId && !run.turnId">&mdash;</span>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>
            </div>
        </section>

        <ScheduledTaskFormDialog
            v-if="formOpen"
            :open="formOpen"
            :task="editingTask"
            :models="models"
            :saving="saving"
            @close="formOpen = false"
            @save="saveTask"
        />

        <DialogShell
            v-if="deleteOpen"
            :open="deleteOpen"
            max-width-class="max-w-sm"
            dismissible
            @close="deleteOpen = false"
        >
            <h2 class="text-base font-bold text-text-primary">
                {{ t('settings.scheduledTasks.deleteTitle') }}
            </h2>
            <p class="mt-2 text-sm leading-6 text-text-secondary">
                {{ t('settings.scheduledTasks.deleteDescription') }}
            </p>
            <div class="mt-5 flex justify-end gap-2">
                <Button variant="outline" @click="deleteOpen = false">
                    {{ t('common.cancel') }}
                </Button>
                <Button variant="danger" :disabled="deleting" @click="confirmDelete">
                    {{ t('settings.scheduledTasks.deleteConfirm') }}
                </Button>
            </div>
        </DialogShell>
    </div>
</template>
