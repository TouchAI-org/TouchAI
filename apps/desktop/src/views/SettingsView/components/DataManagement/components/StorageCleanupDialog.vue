<script setup lang="ts">
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
        () => selected.value.includes('database') || selected.value.includes('assets')
    );
    const estimate = computed(() =>
        props.summary.categories.reduce((total, category) => {
            if (selected.value.includes(category.id)) return total + category.bytes;
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
    const warningKeys: Partial<Record<StorageCategory, MessageKey>> = {
        attachments: 'settings.storage.selection.warnAttachments',
        clipboard: 'settings.storage.selection.warnClipboard',
        temporary: 'settings.storage.selection.warnTemporary',
        recordings: 'settings.storage.selection.warnRecordings',
        database: 'settings.storage.selection.warnDatabase',
        assets: 'settings.storage.selection.warnAssets',
        browser: 'settings.storage.selection.warnBrowser',
    };
    const warnings = computed(() =>
        selected.value
            .filter(
                (category) => category !== 'attachments' || !selected.value.includes('database')
            )
            .map((category) => warningKeys[category])
            .filter((key): key is MessageKey => key !== undefined)
    );
    watch(
        () => props.open,
        (open) => {
            if (open) {
                unused.value = unusedBytes.value > 0;
                selected.value = [];
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
        emit('confirm', { unused: unused.value, categories: [...selected.value] });
    }
</script>

<template>
    <DialogShell
        :open="open"
        :dismissible="!busy"
        max-width-class="max-w-lg"
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
                    :disabled="disabled || unusedBytes === 0"
                />
                <label
                    for="storage-choice-unused"
                    class="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-4 text-compact"
                >
                    <span>{{ t('settings.storage.safeCleanup') }}</span>
                    <span class="whitespace-nowrap text-text-secondary tabular-nums">
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
            <div
                v-for="category in categories"
                :key="category.key"
                class="flex items-center gap-3 py-1.5"
            >
                <Checkbox
                    :id="`storage-choice-${category.key}`"
                    :data-testid="`storage-choice-${category.key}`"
                    :model-value="selected.includes(category.key)"
                    :disabled="disabled || (category.fileCount === 0 && category.value === 0)"
                    @update:model-value="selectCategory(category.key, $event)"
                />
                <label
                    :for="`storage-choice-${category.key}`"
                    class="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-4 text-compact"
                >
                    <span>{{ category.label }}</span>
                    <span class="whitespace-nowrap text-text-secondary tabular-nums">
                        {{ formatBytes(category.value) }}
                    </span>
                </label>
            </div>
        </div>
        <div
            v-if="selected.length"
            class="mb-4 space-y-1 text-caption text-text-warning"
            role="status"
            aria-live="polite"
        >
            <p>{{ t('settings.storage.selection.irreversible') }}</p>
            <p v-for="key in warnings" :key="key">{{ t(key) }}</p>
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
