<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import DialogShell from '@components/DialogShell.vue';
    import { Button } from '@components/ui/button';
    import { Checkbox } from '@components/ui/checkbox';
    import { DialogDescription, DialogTitle } from '@components/ui/dialog';
    import { computed, ref, watch } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import {
        SAFE_STORAGE_CATEGORIES,
        type StorageCategory,
        type StorageCleanupSelection,
        type StorageHistoryKind,
        type StorageSummary,
    } from '@/services/NativeService/storage';

    const props = defineProps<{
        open: boolean;
        disabled: boolean;
        busy: boolean;
        summary: StorageSummary;
        categories: Array<{
            key: StorageCategory;
            label: string;
            value: number;
            fileCount: number;
        }>;
        formatBytes: (bytes: number) => string;
    }>();
    const emit = defineEmits<{ close: []; confirm: [selection: StorageCleanupSelection] }>();
    const unused = ref(false);
    const selected = ref<StorageCategory[]>([]);
    const ranges = ref<Partial<Record<StorageCategory, 0 | 7 | 30 | 90>>>({});
    const databaseScope = ref<StorageHistoryKind | 'all'>('sessions');
    const logScope = ref<'all' | 'activity' | 'crashes'>('all');
    const logOptions = computed(() => [
        { value: 'all' as const, label: t('settings.storage.logs.all') },
        { value: 'activity' as const, label: t('settings.storage.logs.activity') },
        { value: 'crashes' as const, label: t('settings.diagnostics.crashRecords') },
    ]);
    const rangeOptions = computed(() =>
        ([0, 7, 30, 90] as const).map((days) => ({
            value: days,
            label:
                days === 0
                    ? t('settings.storage.range.all')
                    : t('settings.storage.range.older', { days }),
        }))
    );
    const databaseOptions = computed(() => [
        { value: 'sessions' as const, label: t('settings.dataManagement.clearAllSessions') },
        { value: 'messages' as const, label: t('settings.dataManagement.clearAllMessages') },
        { value: 'turns' as const, label: t('settings.dataManagement.clearSessionTurns') },
        { value: 'all' as const, label: t('settings.storage.scope.allData') },
    ]);
    const databaseDescription = computed(() =>
        t(
            databaseScope.value === 'sessions'
                ? 'settings.dataManagement.clearAllSessionsDescription'
                : databaseScope.value === 'messages'
                  ? 'settings.dataManagement.clearAllMessagesDescription'
                  : databaseScope.value === 'turns'
                    ? 'settings.dataManagement.clearSessionTurnsDescription'
                    : 'settings.storage.selection.descriptionDatabase'
        )
    );
    function hasRange(category: StorageCategory) {
        return !['database', 'assets', 'browser'].includes(category);
    }
    function categoryBytes(category: StorageCategory) {
        const usage = props.summary.categories.find((item) => item.id === category);
        const days = ranges.value[category];
        return days ? (usage?.olderThanDays?.[days] ?? usage?.bytes ?? 0) : (usage?.bytes ?? 0);
    }
    const unusedBytes = computed(() =>
        props.summary.categories.reduce(
            (total, category) =>
                total +
                (SAFE_STORAGE_CATEGORIES.includes(category.id) ? category.reclaimableBytes : 0),
            props.summary.databaseFreeBytes
        )
    );
    const available = computed(() =>
        props.categories.filter((category) => category.fileCount > 0 || category.value > 0)
    );
    const restart = computed(
        () =>
            (selected.value.includes('database') && databaseScope.value === 'all') ||
            selected.value.includes('assets')
    );
    const estimate = computed(() =>
        props.summary.categories.reduce((total, category) => {
            if (selected.value.includes(category.id)) return total + categoryBytes(category.id);
            if (!unused.value) return total;
            if (category.id === 'database') return total + props.summary.databaseFreeBytes;
            return (
                total +
                (SAFE_STORAGE_CATEGORIES.includes(category.id) ? category.reclaimableBytes : 0)
            );
        }, 0)
    );
    const allSelected = computed<boolean | 'indeterminate'>(() => {
        if (selected.value.length === 0) return false;
        return selected.value.length === available.value.length ? true : 'indeterminate';
    });
    const descriptionKeys: Record<StorageCategory, MessageKey> = {
        attachments: 'settings.storage.selection.descriptionAttachments',
        clipboard: 'settings.storage.selection.descriptionClipboard',
        thumbnails: 'settings.storage.selection.descriptionThumbnails',
        temporary: 'settings.storage.selection.descriptionTemporary',
        recordings: 'settings.storage.selection.descriptionRecordings',
        logs: 'settings.storage.selection.descriptionLogs',
        database: 'settings.storage.selection.descriptionDatabase',
        assets: 'settings.storage.selection.descriptionAssets',
        browser: 'settings.storage.selection.descriptionBrowser',
    };
    watch(
        () => props.open,
        (open) => {
            if (open) {
                unused.value = unusedBytes.value > 0;
                selected.value = [];
                ranges.value = {};
                databaseScope.value = 'sessions';
                logScope.value = 'all';
            }
        }
    );

    function selectCategory(category: StorageCategory, checked: boolean | 'indeterminate') {
        selected.value =
            checked === true
                ? props.categories
                      .map((item) => item.key)
                      .filter((key) => key === category || selected.value.includes(key))
                : selected.value.filter((key) => key !== category);
    }

    function submit() {
        if (props.disabled || (!unused.value && selected.value.length === 0)) return;
        const olderThanDays = Object.fromEntries(
            selected.value
                .filter((category) => ranges.value[category])
                .map((category) => [category, ranges.value[category]])
        ) as StorageCleanupSelection['olderThanDays'];
        emit('confirm', {
            unused: unused.value,
            categories: [...selected.value],
            ...(Object.keys(olderThanDays ?? {}).length ? { olderThanDays } : {}),
            ...(selected.value.includes('database') && databaseScope.value !== 'all'
                ? { history: databaseScope.value }
                : {}),
            ...(selected.value.includes('logs') && logScope.value !== 'all'
                ? { logScope: logScope.value }
                : {}),
        });
    }
</script>

<template>
    <DialogShell
        :open="open"
        :dismissible="!busy"
        max-width-class="max-w-2xl"
        @close="emit('close')"
    >
        <DialogTitle>{{ t('settings.storage.selection.title') }}</DialogTitle>
        <DialogDescription class="sr-only">
            {{ t('settings.storage.selection.description') }}
        </DialogDescription>
        <div class="my-4 space-y-2">
            <div class="flex items-center gap-3 py-2">
                <Checkbox
                    id="storage-choice-unused"
                    v-model="unused"
                    data-testid="storage-choice-unused"
                    aria-labelledby="storage-choice-unused-label"
                    aria-describedby="storage-choice-unused-description"
                    :disabled="disabled || unusedBytes === 0"
                />
                <label
                    for="storage-choice-unused"
                    class="flex min-w-0 flex-1 cursor-pointer items-baseline justify-between gap-4 text-compact"
                >
                    <span class="min-w-0">
                        <span id="storage-choice-unused-label" class="mr-2">
                            {{ t('settings.storage.safeCleanup') }}
                        </span>
                        <span
                            id="storage-choice-unused-description"
                            class="text-caption text-text-secondary"
                        >
                            {{ t('settings.storage.selection.descriptionUnused') }}
                        </span>
                    </span>
                    <span class="shrink-0 whitespace-nowrap text-text-secondary tabular-nums">
                        {{ formatBytes(unusedBytes) }}
                    </span>
                </label>
            </div>
            <div class="flex items-center gap-3 border-t border-border-subtle pt-3 pb-1">
                <Checkbox
                    id="storage-choice-all"
                    :model-value="allSelected"
                    :disabled="disabled || available.length === 0"
                    data-testid="storage-choice-all"
                    @update:model-value="
                        selected = $event === true ? available.map((category) => category.key) : []
                    "
                />
                <label
                    for="storage-choice-all"
                    class="cursor-pointer text-caption text-text-secondary"
                >
                    {{ t('settings.storage.selection.selectAll') }}
                </label>
            </div>
            <div v-for="category in categories" :key="category.key" class="space-y-2 py-1.5">
                <div class="flex items-center gap-3">
                    <Checkbox
                        :id="`storage-choice-${category.key}`"
                        :data-testid="`storage-choice-${category.key}`"
                        :aria-labelledby="`storage-choice-${category.key}-label`"
                        :aria-describedby="`storage-choice-${category.key}-description`"
                        :model-value="selected.includes(category.key)"
                        :disabled="disabled || (category.fileCount === 0 && category.value === 0)"
                        @update:model-value="selectCategory(category.key, $event)"
                    />
                    <label
                        :for="`storage-choice-${category.key}`"
                        class="flex min-w-0 flex-1 cursor-pointer items-baseline justify-between gap-4 text-compact"
                    >
                        <span class="min-w-0">
                            <span :id="`storage-choice-${category.key}-label`" class="mr-2">
                                {{ category.label }}
                            </span>
                            <span
                                :id="`storage-choice-${category.key}-description`"
                                class="text-caption text-text-secondary"
                            >
                                {{
                                    category.key === 'database' && selected.includes('database')
                                        ? databaseDescription
                                        : t(descriptionKeys[category.key])
                                }}
                            </span>
                        </span>
                        <span class="shrink-0 whitespace-nowrap text-text-secondary tabular-nums">
                            {{
                                formatBytes(
                                    selected.includes(category.key)
                                        ? categoryBytes(category.key)
                                        : category.value
                                )
                            }}
                        </span>
                    </label>
                </div>
                <div
                    v-if="
                        selected.includes(category.key) &&
                        (hasRange(category.key) || category.key === 'database')
                    "
                    class="ml-7 max-w-xs space-y-2"
                >
                    <CustomSelect
                        v-if="category.key === 'logs'"
                        v-model="logScope"
                        :options="logOptions"
                        :disabled="disabled"
                        trigger-test-id="storage-log-scope"
                        :aria-label="t('settings.storage.logs.label')"
                    />
                    <CustomSelect
                        v-if="category.key === 'database'"
                        v-model="databaseScope"
                        :options="databaseOptions"
                        :disabled="disabled"
                        trigger-test-id="storage-database-scope"
                        :aria-label="t('settings.storage.scope.label')"
                    />
                    <CustomSelect
                        v-else
                        :model-value="ranges[category.key] ?? 0"
                        :options="rangeOptions"
                        :disabled="disabled"
                        :trigger-test-id="`storage-range-${category.key}`"
                        :aria-label="
                            t('settings.storage.range.label', { category: category.label })
                        "
                        @update:model-value="ranges[category.key] = $event"
                    />
                </div>
            </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="text-caption text-text-secondary tabular-nums">
                {{ t('settings.storage.selection.estimate', { size: formatBytes(estimate) }) }}
            </span>
            <div class="flex items-center gap-2">
                <Button
                    variant="outline-neutral"
                    data-testid="storage-cleanup-cancel"
                    :disabled="busy"
                    @click="emit('close')"
                >
                    {{ t('common.cancel') }}
                </Button>
                <Button
                    :variant="selected.length ? 'danger' : 'strong'"
                    data-testid="storage-cleanup-confirm"
                    :disabled="disabled || (!unused && selected.length === 0)"
                    @click="submit"
                >
                    {{
                        busy
                            ? t('settings.storage.cleaning')
                            : restart
                              ? t('settings.storage.selection.deleteAndRestart')
                              : selected.length
                                ? t('settings.storage.selection.deleteSelected')
                                : t('settings.storage.cleanup')
                    }}
                </Button>
            </div>
        </div>
    </DialogShell>
</template>
