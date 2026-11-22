<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import DialogShell from '@components/DialogShell.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { computed, ref, watch } from 'vue';

    import type { ModelWithProvider } from '@/app/api/models/administration';
    import type { ScheduledTask, ScheduledTaskDraft } from '@/app/api/scheduler/administration';
    import { t } from '@/i18n';

    import {
        buildCronExpression,
        detectCronPreset,
        parseWallClock,
        type RecurringPreset,
        splitCronTime,
    } from './presentation';

    interface Props {
        open: boolean;
        task?: ScheduledTask;
        models: ModelWithProvider[];
        saving?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        task: undefined,
        saving: false,
    });
    const emit = defineEmits<{
        close: [];
        save: [input: ScheduledTaskDraft];
    }>();

    const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const timezoneOptions = (() => {
        const supported = (
            Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
        ).supportedValuesOf?.('timeZone');
        return [...new Set([localTimezone, ...(supported ?? []), 'UTC'])].map((value) => ({
            value,
            label: value,
        }));
    })();
    const presetOptions: Array<{ value: RecurringPreset; label: string }> = [
        { value: 'daily', label: t('settings.scheduledTasks.presetDaily') },
        { value: 'weekdays', label: t('settings.scheduledTasks.presetWeekdays') },
        { value: 'weekly', label: t('settings.scheduledTasks.presetWeekly') },
        { value: 'custom', label: t('settings.scheduledTasks.presetCustom') },
    ];
    const modelOptions = computed(() => [
        { value: '', label: t('settings.scheduledTasks.defaultModel') },
        ...props.models.map((model) => ({
            value: `${model.provider_id}:${model.model_id}`,
            label: `${model.provider_name} / ${model.name}`,
        })),
    ]);

    const name = ref('');
    const prompt = ref('');
    const triggerType = ref<'once' | 'recurring'>('recurring');
    const preset = ref<RecurringPreset>('daily');
    const cronExpression = ref('0 9 * * *');
    const date = ref('');
    const time = ref('09:00');
    const timezone = ref(localTimezone);
    const modelKey = ref('');
    const enabled = ref(true);
    const validationError = ref('');

    function wallClockParts(timestamp: number, zone: string) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: zone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(new Date(timestamp));
        const values = new Map(parts.map((part) => [part.type, part.value]));
        return {
            date: `${values.get('year')}-${values.get('month')}-${values.get('day')}`,
            time: `${values.get('hour')}:${values.get('minute')}`,
        };
    }

    function reset() {
        const task = props.task;
        const zone = task?.timezone ?? localTimezone;
        const initial = wallClockParts(task?.nextRunAt ?? Date.now() + 60 * 60 * 1_000, zone);
        name.value = task?.name ?? '';
        prompt.value = task?.prompt ?? '';
        timezone.value = zone;
        enabled.value = task?.enabled ?? true;
        modelKey.value =
            task?.modelId && task.providerId ? `${task.providerId}:${task.modelId}` : '';
        triggerType.value = task?.trigger.type === 'once' ? 'once' : 'recurring';
        date.value =
            task?.trigger.type === 'once'
                ? wallClockParts(task.trigger.timestamp, zone).date
                : initial.date;
        const cronTime =
            task?.trigger.type === 'cron' ? splitCronTime(task.trigger.expression) : null;
        time.value =
            task?.trigger.type === 'once'
                ? wallClockParts(task.trigger.timestamp, zone).time
                : cronTime
                  ? `${String(cronTime.hour).padStart(2, '0')}:${String(cronTime.minute).padStart(2, '0')}`
                  : initial.time;
        preset.value =
            task?.trigger.type === 'cron' ? detectCronPreset(task.trigger.expression) : 'daily';
        cronExpression.value =
            task?.trigger.type === 'cron'
                ? task.trigger.expression
                : buildCronExpression('daily', time.value);
        validationError.value = '';
    }

    watch(
        () => [props.open, props.task] as const,
        ([open]) => {
            if (open) reset();
        },
        { immediate: true }
    );

    watch(preset, (next) => {
        if (next !== 'custom') cronExpression.value = buildCronExpression(next, time.value);
    });
    watch(time, (next) => {
        if (triggerType.value === 'recurring' && preset.value !== 'custom') {
            cronExpression.value = buildCronExpression(preset.value, next);
        }
    });

    const title = computed(() =>
        props.task
            ? t('settings.scheduledTasks.editTitle')
            : t('settings.scheduledTasks.createTitle')
    );

    function submit() {
        validationError.value = '';
        const normalizedName = name.value.trim();
        const normalizedPrompt = prompt.value.trim();
        if (!normalizedName || !normalizedPrompt) {
            validationError.value = t('settings.scheduledTasks.enterNameAndPrompt');
            return;
        }

        const selectedModel = props.models.find(
            (model) => `${model.provider_id}:${model.model_id}` === modelKey.value
        );
        let trigger: ScheduledTaskDraft['trigger'];
        if (triggerType.value === 'once') {
            const timestamp = parseWallClock(date.value, time.value, timezone.value);
            if (timestamp === null) {
                validationError.value = t('settings.scheduledTasks.futureOnceRequired');
                return;
            }
            const originalOnceTimestamp =
                props.task?.trigger.type === 'once' ? props.task.trigger.timestamp : undefined;
            if (timestamp <= Date.now() && (enabled.value || timestamp !== originalOnceTimestamp)) {
                validationError.value = t('settings.scheduledTasks.futureOnceRequired');
                return;
            }
            trigger = { type: 'once', timestamp };
        } else {
            trigger = {
                type: 'cron',
                expression:
                    preset.value === 'custom'
                        ? cronExpression.value.trim()
                        : buildCronExpression(preset.value, time.value),
            };
        }

        emit('save', {
            name: normalizedName,
            prompt: normalizedPrompt,
            trigger,
            timezone: timezone.value,
            modelId: selectedModel?.model_id,
            providerId: selectedModel?.provider_id,
            enabled: enabled.value,
        });
    }
</script>

<template>
    <DialogShell :open="props.open" max-width-class="max-w-2xl" dismissible @close="emit('close')">
        <form class="space-y-5" @submit.prevent="submit">
            <h2 class="text-base font-bold text-text-primary">{{ title }}</h2>

            <div class="grid gap-4 sm:grid-cols-2">
                <label class="space-y-1.5">
                    <span class="block text-sm font-medium text-text-primary">
                        {{ t('settings.scheduledTasks.name') }}
                    </span>
                    <Input
                        v-model="name"
                        :placeholder="t('settings.scheduledTasks.namePlaceholder')"
                        data-testid="scheduled-task-name"
                    />
                </label>
                <label class="space-y-1.5">
                    <span class="block text-sm font-medium text-text-primary">
                        {{ t('settings.scheduledTasks.timezone') }}
                    </span>
                    <CustomSelect
                        v-model="timezone"
                        :options="timezoneOptions"
                        protect-option-text
                    />
                </label>
            </div>

            <label class="space-y-1.5">
                <span class="block text-sm font-medium text-text-primary">
                    {{ t('settings.scheduledTasks.prompt') }}
                </span>
                <Input
                    v-model="prompt"
                    class="h-24 items-start py-2"
                    :placeholder="t('settings.scheduledTasks.promptPlaceholder')"
                    data-testid="scheduled-task-prompt"
                />
            </label>

            <div class="grid gap-4 sm:grid-cols-2">
                <label class="space-y-1.5">
                    <span class="block text-sm font-medium text-text-primary">
                        {{ t('settings.scheduledTasks.model') }}
                    </span>
                    <CustomSelect
                        v-model="modelKey"
                        :options="modelOptions"
                        :disabled="props.models.length === 0"
                    />
                </label>
                <div class="space-y-1.5">
                    <span class="block text-sm font-medium text-text-primary">
                        {{ t('settings.scheduledTasks.enabled') }}
                    </span>
                    <div class="flex h-9 items-center">
                        <Switch v-model="enabled" />
                    </div>
                </div>
            </div>

            <div class="rounded-card border border-border-subtle bg-surface-sunken/60 p-4">
                <div class="grid gap-4 sm:grid-cols-2">
                    <label class="space-y-1.5">
                        <span class="block text-sm font-medium text-text-primary">
                            {{ t('settings.scheduledTasks.triggerType') }}
                        </span>
                        <CustomSelect
                            v-model="triggerType"
                            :options="[
                                {
                                    value: 'recurring',
                                    label: t('settings.scheduledTasks.recurring'),
                                },
                                { value: 'once', label: t('settings.scheduledTasks.once') },
                            ]"
                        />
                    </label>
                    <label v-if="triggerType === 'recurring'" class="space-y-1.5">
                        <span class="block text-sm font-medium text-text-primary">
                            {{ t('settings.scheduledTasks.preset') }}
                        </span>
                        <CustomSelect v-model="preset" :options="presetOptions" />
                    </label>
                </div>

                <div v-if="triggerType === 'once'" class="mt-4 grid gap-4 sm:grid-cols-2">
                    <label class="space-y-1.5">
                        <span class="block text-sm font-medium text-text-primary">
                            {{ t('settings.scheduledTasks.date') }}
                        </span>
                        <Input v-model="date" type="date" />
                    </label>
                    <label class="space-y-1.5">
                        <span class="block text-sm font-medium text-text-primary">
                            {{ t('settings.scheduledTasks.time') }}
                        </span>
                        <Input v-model="time" type="time" />
                    </label>
                </div>

                <div v-else class="mt-4 grid gap-4 sm:grid-cols-2">
                    <label class="space-y-1.5">
                        <span class="block text-sm font-medium text-text-primary">
                            {{ t('settings.scheduledTasks.time') }}
                        </span>
                        <Input v-model="time" type="time" />
                    </label>
                    <label v-if="preset === 'custom'" class="space-y-1.5">
                        <span class="block text-sm font-medium text-text-primary">
                            {{ t('settings.scheduledTasks.cronExpression') }}
                        </span>
                        <Input
                            v-model="cronExpression"
                            class="font-mono"
                            spellcheck="false"
                            data-testid="scheduled-task-cron"
                        />
                    </label>
                </div>
                <p
                    v-if="triggerType === 'recurring' && preset === 'custom'"
                    class="mt-2 text-xs text-muted-foreground"
                >
                    {{ t('settings.scheduledTasks.cronHelp') }}
                </p>
            </div>

            <p
                v-if="validationError"
                class="text-sm text-text-danger"
                role="alert"
                data-testid="scheduled-task-validation"
            >
                {{ validationError }}
            </p>

            <div class="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" @click="emit('close')">
                    {{ t('common.cancel') }}
                </Button>
                <Button type="submit" :disabled="props.saving">
                    {{ props.task ? t('common.save') : t('common.create') }}
                </Button>
            </div>
        </form>
    </DialogShell>
</template>
