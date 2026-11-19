<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Button } from '@components/ui/button';
    import DonutChart from '@components/ui/donut-chart/DonutChart.vue';
    import { useAlert } from '@composables/useAlert';
    import { log } from '@services/ObservabilityService';
    import { relaunch } from '@tauri-apps/plugin-process';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import { getLocale, type MessageKey, t, tp } from '@/i18n';
    import {
        type StorageCategory,
        type StorageCleanupResult,
        type StorageCleanupSelection,
        type StorageSummary,
    } from '@/services/NativeService/storage';
    import { storageService } from '@/services/StorageService';

    import StorageCleanupDialog from './StorageCleanupDialog.vue';

    defineOptions({
        name: 'SettingsStorageSection',
    });

    const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });
    const emit = defineEmits<{ busyChange: [busy: boolean]; cleaned: [] }>();

    type Operation = 'cleanup' | 'scan' | 'restart';

    const CATEGORY_LABELS: Record<StorageCategory, MessageKey> = {
        attachments: 'settings.storage.category.attachments',
        clipboard: 'settings.storage.category.clipboard',
        thumbnails: 'settings.storage.category.thumbnails',
        temporary: 'settings.storage.category.temporary',
        recordings: 'settings.storage.category.recordings',
        logs: 'settings.storage.category.logs',
        database: 'settings.storage.category.database',
        assets: 'settings.storage.category.assets',
        browser: 'settings.storage.category.browser',
    };
    const SIZE_UNITS: MessageKey[] = [
        'settings.storage.units.bytes',
        'settings.storage.units.kibibytes',
        'settings.storage.units.mebibytes',
        'settings.storage.units.gibibytes',
        'settings.storage.units.tebibytes',
    ];
    const NATIVE_ERROR_MESSAGES = new Map<string, MessageKey>([
        ['storage_busy', 'settings.storage.errors.busy'],
        ['storage_scan_incomplete', 'settings.storage.errors.scanIncomplete'],
        ['storage_invalid_path', 'settings.storage.errors.invalidPath'],
        ['storage_insufficient_space', 'settings.storage.errors.insufficientSpace'],
        ['storage_io_failed', 'settings.storage.errors.ioFailed'],
        ['storage_corrupt_attachment', 'settings.storage.errors.corruptAttachment'],
    ]);
    const alert = useAlert();
    const summary = ref<StorageSummary | null>(null);
    const operation = ref<Operation | null>(null);
    const selectionOpen = ref(false);
    const restartRequired = ref(false);
    const errorKey = ref<MessageKey | null>(null);
    const cleanupResult = ref<StorageCleanupResult | null>(null);
    let disposed = false;

    const numberFormatter = computed(
        () => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 })
    );
    const categories = computed(() =>
        (summary.value?.categories ?? [])
            .map((category) => ({
                key: category.id,
                label: t(CATEGORY_LABELS[category.id]),
                value: category.bytes,
                fileCount: category.fileCount,
            }))
            .sort((first, second) => second.value - first.value)
    );
    const occupiedSlices = computed(() =>
        categories.value.filter((category) => category.value > 0)
    );
    const scanIncomplete = computed(
        () => summary.value?.warnings.includes('storage_scan_incomplete') ?? false
    );
    const unavailable = computed(
        () =>
            props.disabled ||
            restartRequired.value ||
            !summary.value ||
            summary.value.busy ||
            scanIncomplete.value ||
            errorKey.value !== null
    );
    const actionsDisabled = computed(() => operation.value !== null || unavailable.value);
    const refreshLabel = computed(() =>
        t(operation.value === 'scan' ? 'settings.storage.scanning' : 'settings.storage.refresh')
    );
    const visibleWarnings = computed(() => summary.value?.warnings.slice(0, 5) ?? []);
    const visibleFailures = computed(() => cleanupResult.value?.failures.slice(0, 5) ?? []);
    const resultMessage = computed(() => {
        if (cleanupResult.value) {
            return t('settings.storage.results.cleanup', {
                files: cleanupResult.value.removedFiles,
                released: formatBytes(cleanupResult.value.releasedBytes),
                pending: formatBytes(cleanupResult.value.pendingBytes),
                failed: cleanupResult.value.failedFiles,
            });
        }
        return '';
    });

    function formatBytes(bytes: number): string {
        const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
        const unitIndex = Math.min(
            Math.max(0, Math.floor(Math.log2(value || 1) / 10)),
            SIZE_UNITS.length - 1
        );
        return t('settings.storage.size', {
            value: numberFormatter.value.format(value / 1024 ** unitIndex),
            unit: t(SIZE_UNITS[unitIndex] ?? 'settings.storage.units.bytes'),
        });
    }

    function nativeErrorCode(error: unknown): string | undefined {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string'
        ) {
            return error.code;
        }
        return typeof error === 'string'
            ? error
            : error instanceof Error
              ? error.message
              : undefined;
    }

    function nativeNotice(code: string): string {
        const key = NATIVE_ERROR_MESSAGES.get(code);
        return key ? t(key) : t('settings.storage.nativeNotice', { detail: code });
    }

    function reportError(error: unknown, fallback: MessageKey, action: Operation) {
        const code = nativeErrorCode(error);
        log.error('[Storage] Maintenance action failed', {
            action,
            code: code && NATIVE_ERROR_MESSAGES.has(code) ? code : 'unknown',
        });
        if (disposed) return;
        errorKey.value = (code ? NATIVE_ERROR_MESSAGES.get(code) : undefined) ?? fallback;
        alert.error(t(errorKey.value));
    }

    async function readSummary() {
        try {
            const nextSummary = await storageService.scan();
            if (disposed) return;
            summary.value = nextSummary;
            errorKey.value = null;
        } catch (error) {
            reportError(error, 'settings.storage.scanFailed', 'scan');
        }
    }

    async function refresh() {
        if (disposed || operation.value !== null) return;
        operation.value = 'scan';
        errorKey.value = null;
        try {
            await readSummary();
        } finally {
            if (!disposed) operation.value = null;
        }
    }

    async function restart() {
        operation.value = 'restart';
        try {
            await relaunch();
        } catch (error) {
            log.error('[Storage] Cleanup requires a manual restart', error);
            if (!disposed) alert.warning(t('settings.storage.selection.restartRequired'));
        } finally {
            if (!disposed) operation.value = null;
        }
    }

    async function cleanup(selection: StorageCleanupSelection) {
        if (disposed || actionsDisabled.value || !selectionOpen.value) return;
        operation.value = 'cleanup';
        try {
            cleanupResult.value = null;
            const result = await storageService.cleanupSelected(selection);
            const incomplete =
                result.failedFiles > 0 ||
                result.pendingBytes > 0 ||
                result.summary.warnings.length > 0;
            if (!disposed) {
                selectionOpen.value = false;
                summary.value = result.summary;
                cleanupResult.value = result;
                restartRequired.value = result.restartRequired === true;
                if (!result.restartRequired) emit('cleaned');
                if (incomplete) alert.warning(resultMessage.value);
                else alert.success(resultMessage.value);
            }
            if (result.restartRequired && (!incomplete || disposed)) await restart();
        } catch (error) {
            if (!disposed) selectionOpen.value = false;
            reportError(error, 'settings.storage.cleanupFailed', 'cleanup');
        } finally {
            if (!disposed) operation.value = null;
        }
    }

    watch(
        () =>
            operation.value !== null ||
            selectionOpen.value ||
            restartRequired.value ||
            summary.value?.busy === true ||
            errorKey.value === 'settings.storage.errors.busy',
        (busy) => emit('busyChange', busy),
        { immediate: true }
    );
    onMounted(refresh);
    onUnmounted(() => {
        disposed = true;
        emit('busyChange', false);
    });
    defineExpose({ refresh });
</script>

<template>
    <section
        class="@container space-y-4"
        data-testid="settings-storage-section"
        data-settings-search-target="storage"
        :aria-busy="operation !== null"
    >
        <div class="flex items-center justify-between gap-4">
            <h2 class="settings-section-title">{{ t('settings.storage.title') }}</h2>
            <Button
                variant="ghost-neutral"
                data-testid="settings-storage-refresh"
                :aria-label="refreshLabel"
                :title="refreshLabel"
                :disabled="props.disabled || operation !== null || selectionOpen || restartRequired"
                @click="refresh"
            >
                <AppIcon
                    name="refresh"
                    class="size-4"
                    :class="{ 'motion-safe:animate-spin': operation === 'scan' }"
                    aria-hidden="true"
                />
            </Button>
        </div>

        <p
            v-if="errorKey"
            data-testid="settings-storage-error"
            class="text-compact text-text-danger"
            role="alert"
        >
            {{ t(errorKey) }}
        </p>
        <p v-if="summary?.busy && !errorKey" class="text-compact text-text-secondary" role="status">
            {{ t('settings.storage.errors.busy') }}
        </p>
        <div
            v-if="visibleWarnings.length"
            class="space-y-2 text-compact break-words text-text-warning"
            role="alert"
        >
            <p v-for="(warning, index) in visibleWarnings" :key="index">
                {{ nativeNotice(warning) }}
            </p>
            <p v-if="summary && summary.warnings.length > visibleWarnings.length">
                {{
                    tp(
                        'settings.storage.moreWarnings',
                        summary.warnings.length - visibleWarnings.length
                    )
                }}
            </p>
        </div>

        <DonutChart
            v-if="summary"
            data-testid="settings-storage-total"
            :data="occupiedSlices"
            :group-below="0"
            :max-segments="categories.length"
            :total-value="summary.totalBytes"
            :total-label="t('settings.storage.total')"
            :format-value="formatBytes"
            :size="176"
            :thickness="22"
        >
            <template #center-detail="{ activeKey }">
                <span v-if="activeKey" class="text-2xs text-text-secondary">
                    {{
                        tp(
                            'settings.storage.files',
                            categories.find((category) => category.key === activeKey)?.fileCount ??
                                0
                        )
                    }}
                </span>
            </template>
            <template #caption>
                <div data-settings-search-target="storage-cleanup">
                    <Button
                        variant="strong"
                        data-testid="settings-storage-cleanup"
                        :disabled="actionsDisabled"
                        @click="selectionOpen = true"
                    >
                        {{ t('settings.storage.selection.title') }}
                    </Button>
                </div>
            </template>
            <template #legend="{ colorOf, shareOf, bindItem, activeKey }">
                <ul class="settings-storage-legend m-0 grid min-w-0 flex-1 list-none gap-x-2 p-0">
                    <li
                        v-for="category in categories"
                        :key="category.key"
                        :data-testid="`settings-storage-category-${category.key}`"
                        :data-settings-search-target="`storage-category-${category.key}`"
                        class="col-span-full grid grid-cols-subgrid items-center"
                    >
                        <button
                            type="button"
                            class="col-span-full grid min-w-0 grid-cols-subgrid items-center rounded-action px-1 py-1.5 text-left enabled:hover:bg-surface-hover"
                            :class="{ 'bg-surface-hover': activeKey === category.key }"
                            :title="`${tp('settings.storage.files', category.fileCount)} · ${shareOf(category.value)}`"
                            :aria-description="`${tp('settings.storage.files', category.fileCount)} · ${shareOf(category.value)}`"
                            :disabled="category.value === 0"
                            :data-settings-search-target="
                                category.key === 'database'
                                    ? 'storage-compaction'
                                    : category.key === 'recordings' || category.key === 'logs'
                                      ? `storage-${category.key}`
                                      : undefined
                            "
                            v-bind="category.value > 0 ? bindItem(category.key) : {}"
                        >
                            <span class="flex min-w-0 items-center gap-2.5">
                                <span
                                    class="size-2 shrink-0 rounded-full bg-border"
                                    :style="
                                        category.value > 0
                                            ? { backgroundColor: colorOf(category) }
                                            : undefined
                                    "
                                    aria-hidden="true"
                                />
                                <span class="text-compact leading-5 font-medium text-settings-text">
                                    {{ category.label }}
                                </span>
                            </span>
                            <span
                                class="text-right text-compact whitespace-nowrap text-settings-text tabular-nums"
                            >
                                {{ formatBytes(category.value) }}
                            </span>
                        </button>
                    </li>
                </ul>
            </template>
        </DonutChart>

        <StorageCleanupDialog
            v-if="summary"
            :open="selectionOpen"
            :disabled="actionsDisabled"
            :busy="operation === 'cleanup'"
            :summary="summary"
            :categories="categories"
            :format-bytes="formatBytes"
            @close="selectionOpen = false"
            @confirm="cleanup"
        />

        <div v-if="resultMessage" class="space-y-3">
            <p
                data-testid="settings-storage-result"
                class="text-compact text-text-secondary"
                role="status"
                aria-live="polite"
            >
                {{ resultMessage }}
            </p>
            <div v-if="restartRequired" class="flex flex-wrap items-center gap-3">
                <p class="text-caption text-text-warning">
                    {{ t('settings.storage.selection.restartRequired') }}
                </p>
                <Button variant="strong" :disabled="operation !== null" @click="restart">
                    {{ t('settings.storage.selection.restart') }}
                </Button>
            </div>
            <details
                v-if="visibleFailures.length"
                class="text-compact text-text-secondary"
                data-testid="settings-storage-failures"
            >
                <summary class="cursor-pointer">
                    {{ t('settings.storage.results.failures') }}
                </summary>
                <ul class="mt-3 space-y-3 text-xs">
                    <li v-for="(failure, index) in visibleFailures" :key="index" class="space-y-1">
                        <p class="break-all select-text">{{ failure.path }}</p>
                        <p class="break-words">{{ nativeNotice(failure.code) }}</p>
                    </li>
                </ul>
                <p
                    v-if="cleanupResult && cleanupResult.failures.length > visibleFailures.length"
                    class="mt-3 text-xs"
                >
                    {{
                        tp(
                            'settings.storage.results.moreFailures',
                            cleanupResult.failures.length - visibleFailures.length
                        )
                    }}
                </p>
            </details>
        </div>
        <slot />
    </section>
</template>

<style scoped>
    .settings-storage-legend {
        grid-template-columns: minmax(0, 1fr) max-content;
    }
</style>
