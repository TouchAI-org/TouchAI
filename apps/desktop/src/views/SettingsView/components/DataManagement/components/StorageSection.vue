<script setup lang="ts">
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import { log } from '@services/ObservabilityService';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import { getLocale, type MessageKey, t, tp } from '@/i18n';
    import {
        SAFE_STORAGE_CATEGORIES,
        type StorageCategory,
        type StorageCleanupResult,
        type StorageCompactionResult,
        type StorageSummary,
    } from '@/services/NativeService/storage';
    import { storageService } from '@/services/StorageService';

    defineOptions({
        name: 'SettingsStorageSection',
    });

    const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });
    const emit = defineEmits<{ busyChange: [busy: boolean] }>();

    type CleanupKind = 'safe' | 'recordings' | 'logs';
    type Operation = CleanupKind | 'scan' | 'compact';

    const SAFE_CATEGORIES: readonly StorageCategory[] = SAFE_STORAGE_CATEGORIES;
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
    const CLEANUP_CONFIRMATIONS: Record<
        CleanupKind,
        { title: MessageKey; message: MessageKey; action: MessageKey }
    > = {
        safe: {
            title: 'settings.storage.cleanupConfirmTitle',
            message: 'settings.storage.cleanupConfirm',
            action: 'settings.storage.cleanup',
        },
        recordings: {
            title: 'settings.storage.deleteRecordings',
            message: 'settings.storage.recordingsConfirm',
            action: 'settings.storage.deleteRecordings',
        },
        logs: {
            title: 'settings.storage.deleteLogs',
            message: 'settings.storage.logsConfirm',
            action: 'settings.storage.deleteLogs',
        },
    };

    const alert = useAlert();
    const { confirm } = useConfirm();
    const summary = ref<StorageSummary | null>(null);
    const operation = ref<Operation | null>(null);
    const confirming = ref(false);
    const errorKey = ref<MessageKey | null>(null);
    const cleanupResult = ref<StorageCleanupResult | null>(null);
    const compactionResult = ref<StorageCompactionResult | null>(null);
    let disposed = false;

    const numberFormatter = computed(
        () => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 })
    );
    const safeBytes = computed(() =>
        (summary.value?.categories ?? []).reduce(
            (total, category) =>
                total + (SAFE_CATEGORIES.includes(category.id) ? category.reclaimableBytes : 0),
            0
        )
    );
    const scanIncomplete = computed(
        () => summary.value?.warnings.includes('storage_scan_incomplete') ?? false
    );
    const unavailable = computed(
        () =>
            props.disabled ||
            !summary.value ||
            summary.value.busy ||
            scanIncomplete.value ||
            errorKey.value !== null
    );
    const actionsDisabled = computed(() => operation.value !== null || unavailable.value);
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
        if (compactionResult.value) {
            return t('settings.storage.results.compaction', {
                before: formatBytes(compactionResult.value.beforeBytes),
                after: formatBytes(compactionResult.value.afterBytes),
                released: formatBytes(compactionResult.value.releasedBytes),
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

    function categoryBytes(category: StorageCategory): number {
        return summary.value?.categories.find((usage) => usage.id === category)?.bytes ?? 0;
    }

    function categoryHasFiles(category: StorageCategory): boolean {
        return (
            (summary.value?.categories.find((usage) => usage.id === category)?.fileCount ?? 0) > 0
        );
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

    async function cleanup(kind: CleanupKind) {
        const estimate = kind === 'safe' ? safeBytes.value : categoryBytes(kind);
        const hasFiles = kind === 'safe' ? estimate > 0 : categoryHasFiles(kind);
        if (disposed || actionsDisabled.value || !hasFiles) return;
        const options = CLEANUP_CONFIRMATIONS[kind];
        operation.value = kind;
        confirming.value = true;
        try {
            const confirmed = await confirm({
                title: t(options.title),
                message: t(options.message, { size: formatBytes(estimate) }),
                confirmText: t(options.action),
                type: kind === 'safe' ? 'info' : 'danger',
            });
            if (disposed || !confirmed || unavailable.value) return;
            confirming.value = false;
            cleanupResult.value = null;
            compactionResult.value = null;

            const result = await storageService.cleanup(
                kind === 'safe' ? [...SAFE_CATEGORIES] : [kind]
            );
            if (disposed) return;
            summary.value = result.summary;
            cleanupResult.value = result;
            if (result.failedFiles > 0 || result.pendingBytes > 0) {
                alert.warning(resultMessage.value);
            } else {
                alert.success(resultMessage.value);
            }
        } catch (error) {
            reportError(error, 'settings.storage.cleanupFailed', kind);
        } finally {
            if (!disposed) {
                confirming.value = false;
                operation.value = null;
            }
        }
    }

    async function compactDatabase() {
        if (disposed || actionsDisabled.value || !summary.value?.databaseFreeBytes) return;
        operation.value = 'compact';
        confirming.value = true;
        try {
            const confirmed = await confirm({
                title: t('settings.storage.compactDatabase'),
                message: t('settings.storage.compactConfirm', {
                    size: formatBytes(summary.value.databaseFreeBytes),
                }),
                confirmText: t('settings.storage.compact'),
                type: 'warning',
            });
            if (disposed || !confirmed || unavailable.value) return;
            confirming.value = false;
            cleanupResult.value = null;
            compactionResult.value = null;

            const result = await storageService.compactDatabase();
            if (disposed) return;
            compactionResult.value = result;
            alert.success(resultMessage.value);
            await readSummary();
        } catch (error) {
            reportError(error, 'settings.storage.compactionFailed', 'compact');
        } finally {
            if (!disposed) {
                confirming.value = false;
                operation.value = null;
            }
        }
    }

    watch(
        () =>
            operation.value !== null ||
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
        class="space-y-4"
        data-testid="settings-storage-section"
        data-settings-search-target="storage"
    >
        <div class="flex items-center justify-between gap-4">
            <h2 class="settings-section-title">{{ t('settings.storage.title') }}</h2>
            <Button
                variant="outline-neutral"
                data-testid="settings-storage-refresh"
                :disabled="props.disabled || operation !== null"
                @click="refresh"
            >
                {{
                    operation === 'scan'
                        ? t('settings.storage.scanning')
                        : t('settings.storage.refresh')
                }}
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

        <div
            class="settings-row-group divide-y divide-border-subtle"
            :aria-busy="operation !== null && !confirming"
        >
            <template v-if="summary">
                <SettingsRow
                    data-testid="settings-storage-total"
                    control-width="auto"
                    :label="t('settings.storage.total')"
                >
                    <div class="text-right text-lg font-semibold text-text-primary tabular-nums">
                        {{ formatBytes(summary.totalBytes) }}
                    </div>
                </SettingsRow>
                <SettingsRow
                    v-for="category in summary.categories"
                    :key="category.id"
                    :data-testid="`settings-storage-category-${category.id}`"
                    :data-settings-search-target="`storage-category-${category.id}`"
                    control-width="auto"
                    :label="t(CATEGORY_LABELS[category.id])"
                >
                    <div class="flex flex-wrap items-center justify-end gap-3">
                        <span class="text-xs text-text-tertiary">
                            {{ tp('settings.storage.files', category.fileCount) }}
                        </span>
                        <span class="text-compact text-text-primary tabular-nums">
                            {{ formatBytes(category.bytes) }}
                        </span>
                    </div>
                </SettingsRow>
            </template>

            <SettingsRow
                control-width="auto"
                :label="t('settings.storage.safeCleanup')"
                data-settings-search-target="storage-cleanup"
            >
                <div class="flex flex-wrap items-center justify-end gap-3">
                    <span v-if="summary" class="text-xs text-text-secondary tabular-nums">
                        {{
                            safeBytes > 0
                                ? t('settings.storage.reclaimable', {
                                      size: formatBytes(safeBytes),
                                  })
                                : t('settings.storage.noReclaimable')
                        }}
                    </span>
                    <Button
                        variant="strong"
                        data-testid="settings-storage-cleanup"
                        :disabled="actionsDisabled || safeBytes === 0"
                        @click="cleanup('safe')"
                    >
                        {{
                            operation === 'safe' && !confirming
                                ? t('settings.storage.cleaning')
                                : t('settings.storage.cleanup')
                        }}
                    </Button>
                </div>
            </SettingsRow>
            <SettingsRow
                control-width="auto"
                :label="t('settings.storage.compactDatabase')"
                data-settings-search-target="storage-compaction"
            >
                <div class="flex flex-wrap items-center justify-end gap-3">
                    <span v-if="summary" class="text-xs text-text-secondary tabular-nums">
                        {{
                            t('settings.storage.databaseFree', {
                                size: formatBytes(summary.databaseFreeBytes),
                            })
                        }}
                    </span>
                    <Button
                        variant="strong"
                        data-testid="settings-storage-compact"
                        :disabled="actionsDisabled || !summary?.databaseFreeBytes"
                        @click="compactDatabase"
                    >
                        {{
                            operation === 'compact' && !confirming
                                ? t('settings.storage.compacting')
                                : t('settings.storage.compact')
                        }}
                    </Button>
                </div>
            </SettingsRow>
        </div>

        <div class="space-y-4">
            <h3 class="settings-section-title">{{ t('settings.storage.destructiveTitle') }}</h3>
            <div class="settings-row-group divide-y divide-border-subtle">
                <SettingsRow
                    control-width="auto"
                    :label="t('settings.storage.managedRecordings')"
                    data-settings-search-target="storage-recordings"
                >
                    <div class="flex flex-wrap items-center justify-end gap-3">
                        <span v-if="summary" class="text-xs text-text-secondary tabular-nums">
                            {{
                                t('settings.storage.toDelete', {
                                    size: formatBytes(categoryBytes('recordings')),
                                })
                            }}
                        </span>
                        <Button
                            variant="danger"
                            data-testid="settings-storage-recordings"
                            :disabled="actionsDisabled || !categoryHasFiles('recordings')"
                            @click="cleanup('recordings')"
                        >
                            {{
                                operation === 'recordings' && !confirming
                                    ? t('settings.storage.cleaning')
                                    : t('settings.storage.deleteRecordings')
                            }}
                        </Button>
                    </div>
                </SettingsRow>
                <SettingsRow
                    control-width="auto"
                    :label="t('settings.storage.managedLogs')"
                    data-settings-search-target="storage-logs"
                >
                    <div class="flex flex-wrap items-center justify-end gap-3">
                        <span v-if="summary" class="text-xs text-text-secondary tabular-nums">
                            {{
                                t('settings.storage.toDelete', {
                                    size: formatBytes(categoryBytes('logs')),
                                })
                            }}
                        </span>
                        <Button
                            variant="danger"
                            data-testid="settings-storage-logs"
                            :disabled="actionsDisabled || !categoryHasFiles('logs')"
                            @click="cleanup('logs')"
                        >
                            {{
                                operation === 'logs' && !confirming
                                    ? t('settings.storage.cleaning')
                                    : t('settings.storage.deleteLogs')
                            }}
                        </Button>
                    </div>
                </SettingsRow>
            </div>
        </div>

        <div v-if="resultMessage" class="settings-row-group space-y-3 px-5 py-4">
            <p
                data-testid="settings-storage-result"
                class="text-compact text-text-secondary"
                role="status"
                aria-live="polite"
            >
                {{ resultMessage }}
            </p>
            <details v-if="visibleFailures.length" class="text-compact text-text-secondary">
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
    </section>
</template>
