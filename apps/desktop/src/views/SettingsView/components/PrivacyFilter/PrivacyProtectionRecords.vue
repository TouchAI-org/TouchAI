<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import EmptyState from '@components/EmptyState.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import BarChart from '@components/ui/bar-chart/BarChart.vue';
    import { Button } from '@components/ui/button';
    import MetricCards from '@components/ui/metric-cards/MetricCards.vue';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import { useMotion } from '@composables/useMotion';
    import { motion } from 'motion-v';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { log } from '@/app/api/diagnostics';
    import {
        PRIVACY_FILTER_RECORDS_RETENTION_DAYS,
        type PrivacyProtectionKind,
        type PrivacyProtectionRecord,
        usePrivacyApi,
    } from '@/app/api/privacy';
    import { getLocale, t } from '@/i18n';

    import PrivacyProtectionDetails from './PrivacyProtectionDetails.vue';
    import { privacyProtectionKindLabels as kindLabels } from './privacyProtectionLabels';

    const props = defineProps<{ disabled: boolean }>();
    const privacyApi = usePrivacyApi();
    type RangeDays = 7 | typeof PRIVACY_FILTER_RECORDS_RETENTION_DAYS;
    type CategoryFilter = 'all' | PrivacyProtectionKind;
    type ModeFilter = 'all' | 'model' | 'rules';
    type OutcomeFilter = 'all' | 'protected' | 'blocked';
    const DAY_MILLIS = 24 * 60 * 60 * 1_000;
    const PAGE_SIZE = 20;
    const records = ref<PrivacyProtectionRecord[]>([]);
    const detailIds = ref<Set<string>>(new Set());
    const sessionTitles = ref<Map<number, string>>(new Map());
    const selectedRecord = ref<PrivacyProtectionRecord | null>(null);
    const readyRecordId = ref<string | null>(null);
    const loading = ref(false);
    const clearing = ref(false);
    const loadFailed = ref(false);
    const visibleLimit = ref(PAGE_SIZE);
    const rangeDays = ref<RangeDays>(PRIVACY_FILTER_RECORDS_RETENTION_DAYS);
    const categoryFilter = ref<CategoryFilter>('all');
    const modeFilter = ref<ModeFilter>('all');
    const outcomeFilter = ref<OutcomeFilter>('all');
    const now = ref(Date.now());
    const { confirm } = useConfirm();
    const { transitions } = useMotion();
    const alert = useAlert();
    let unlisten: (() => void) | undefined;
    let unmounted = false;
    let requestSequence = 0;

    const kindOrder = Object.keys(kindLabels) as PrivacyProtectionKind[];
    const rangeOptions = computed<Array<{ value: RangeDays; label: string }>>(() => [
        { value: 7, label: t('settings.privacyFilter.records.range.sevenDays') },
        {
            value: PRIVACY_FILTER_RECORDS_RETENTION_DAYS,
            label: t('settings.privacyFilter.records.range.thirtyDays'),
        },
    ]);

    const rangeStart = computed(() => {
        const start = new Date(now.value);
        start.setDate(start.getDate() - rangeDays.value + 1);
        start.setHours(0, 0, 0, 0);
        return start.getTime();
    });
    const recordsInRange = computed(() =>
        records.value.filter((record) => record.createdAt >= rangeStart.value)
    );
    const requestsInRange = computed(() =>
        recordsInRange.value.filter((record) => record.direction !== 'restore')
    );
    const categoryCounts = computed(() => {
        const counts = new Map<PrivacyProtectionKind, number>();
        for (const record of recordsInRange.value) {
            for (const category of record.categories) {
                counts.set(category.kind, (counts.get(category.kind) ?? 0) + category.count);
            }
        }
        return counts;
    });
    const categoryOptions = computed(() => [
        {
            value: 'all' as CategoryFilter,
            label: t('settings.privacyFilter.records.filter.allCategories'),
        },
        ...kindOrder
            .filter((kind) => (categoryCounts.value.get(kind) ?? 0) > 0)
            .map((kind) => ({
                value: kind as CategoryFilter,
                label: `${t(kindLabels[kind])} (${categoryCounts.value.get(kind)})`,
            })),
    ]);
    const modeOptions = computed<Array<{ value: ModeFilter; label: string }>>(() => [
        { value: 'all', label: t('settings.privacyFilter.records.filter.allModes') },
        { value: 'model', label: t('settings.privacyFilter.mode.model') },
        { value: 'rules', label: t('settings.privacyFilter.mode.rules') },
    ]);
    const outcomeOptions = computed<Array<{ value: OutcomeFilter; label: string }>>(() => [
        { value: 'all', label: t('settings.privacyFilter.records.filter.allOutcomes') },
        { value: 'protected', label: t('settings.privacyFilter.records.filter.protected') },
        { value: 'blocked', label: t('settings.privacyFilter.records.filter.blocked') },
    ]);
    const summary = computed(() => ({
        requests: requestsInRange.value.length,
        protectedCount: requestsInRange.value.reduce(
            (total, record) => total + record.maskedCount,
            0
        ),
        blockedCount: requestsInRange.value.filter((record) => record.outcome === 'blocked').length,
    }));
    const summaryCards = computed(() =>
        [
            {
                key: 'requests',
                label: t('settings.privacyFilter.records.summary.requests'),
                value: summary.value.requests,
            },
            {
                key: 'masked',
                label: t('settings.privacyFilter.records.summary.masked'),
                value: summary.value.protectedCount,
            },
            {
                key: 'blocked',
                label: t('settings.privacyFilter.records.summary.blocked'),
                value: summary.value.blockedCount,
            },
        ].map((card) => ({
            ...card,
            value: card.value.toLocaleString(getLocale()),
            counter: { value: card.value },
        }))
    );
    const dailyRecords = computed(() => {
        const counts = new Map<string, number>();
        for (const record of requestsInRange.value) {
            const key = localDayKey(record.createdAt);
            counts.set(key, (counts.get(key) ?? 0) + record.maskedCount);
        }
        const dateFormat = new Intl.DateTimeFormat(getLocale(), {
            month: 'short',
            day: 'numeric',
        });
        return Array.from({ length: rangeDays.value }, (_, index) => {
            const day = new Date(rangeStart.value);
            day.setDate(day.getDate() + index);
            const key = localDayKey(day.getTime());
            return {
                key,
                label: dateFormat.format(day),
                axisLabel: `${day.getMonth() + 1}/${day.getDate()}`,
                values: { masked: counts.get(key) ?? 0 },
            };
        });
    });
    const chartSeries = computed(() => [
        {
            key: 'masked',
            label: t('settings.privacyFilter.records.summary.masked'),
            color: 'var(--color-text-secondary)',
        },
    ]);
    const filteredRecords = computed(() =>
        recordsInRange.value.filter(
            (record) =>
                (categoryFilter.value === 'all' ||
                    record.categories.some((category) => category.kind === categoryFilter.value)) &&
                (modeFilter.value === 'all' || record.mode === modeFilter.value) &&
                (outcomeFilter.value === 'all' || record.outcome === outcomeFilter.value)
        )
    );
    const visibleRecords = computed(() => filteredRecords.value.slice(0, visibleLimit.value));
    const recordGroups = computed(() => {
        const groups: Array<{ key: string; label: string; records: PrivacyProtectionRecord[] }> =
            [];
        for (const record of visibleRecords.value) {
            const key = localDayKey(record.createdAt);
            let group = groups[groups.length - 1];
            if (!group || group.key !== key) {
                group = { key, label: dayLabel(record.createdAt), records: [] };
                groups.push(group);
            }
            group.records.push(record);
        }
        return groups;
    });
    const hasActiveFilters = computed(
        () =>
            categoryFilter.value !== 'all' ||
            modeFilter.value !== 'all' ||
            outcomeFilter.value !== 'all'
    );

    function detailsAvailable(record: PrivacyProtectionRecord): boolean {
        return detailIds.value.has(record.id);
    }

    function sessionTitle(record: PrivacyProtectionRecord): string {
        const id = record.sessionId;
        return (
            (id ? sessionTitles.value.get(id) : undefined) ??
            t('settings.privacyFilter.records.unknownSession')
        );
    }

    function modeAndCategories(record: PrivacyProtectionRecord): string {
        const mode = t(
            record.mode === 'model' ? 'conversation.privacy.model' : 'conversation.privacy.builtin'
        );
        const categories = record.categories
            .slice(0, 2)
            .map((category) => t(kindLabels[category.kind]));
        return categories.length ? `${mode} / ${categories.join('、')}` : mode;
    }

    async function refresh() {
        const sequence = ++requestSequence;
        loading.value = true;
        try {
            const [next, availableDetailIds] = await Promise.all([
                privacyApi.getRecords(),
                privacyApi.getDetailRecordIds(),
            ]);
            if (unmounted || sequence !== requestSequence) return;
            records.value = next;
            detailIds.value = new Set(availableDetailIds);
            const sessionIds = [
                ...new Set(
                    next
                        .map((record) => record.sessionId)
                        .filter((id): id is number => Number.isSafeInteger(id) && (id ?? 0) > 0)
                ),
            ];
            const titles = sessionIds.length ? await privacyApi.findSessionTitles(sessionIds) : [];
            if (unmounted || sequence !== requestSequence) return;
            sessionTitles.value = new Map(titles.map((row) => [row.id, row.title]));
            if (
                selectedRecord.value &&
                (!next.some((record) => record.id === selectedRecord.value?.id) ||
                    !detailsAvailable(selectedRecord.value))
            ) {
                closeDetails();
            }
            now.value = Date.now();
            loadFailed.value = false;
        } catch {
            if (unmounted || sequence !== requestSequence) return;
            loadFailed.value = true;
            log.warn('[PrivacyProtection] Could not read protection records');
        } finally {
            if (sequence === requestSequence) loading.value = false;
        }
    }

    async function clear() {
        if (props.disabled || clearing.value || !records.value.length) return;
        const approved = await confirm({
            title: t('settings.privacyFilter.records.clearTitle'),
            message: t('settings.privacyFilter.records.clearDescription'),
            confirmText: t('settings.privacyFilter.records.clear'),
            type: 'danger',
        });
        if (!approved || props.disabled || unmounted) return;
        clearing.value = true;
        try {
            await privacyApi.clearRecords();
            requestSequence += 1;
            loading.value = false;
            closeDetails();
            records.value = [];
            visibleLimit.value = PAGE_SIZE;
            resetFilters();
        } catch {
            alert.error(t('settings.privacyFilter.records.clearFailed'));
        } finally {
            clearing.value = false;
        }
    }

    function openRecord(record: PrivacyProtectionRecord): void {
        if (!detailsAvailable(record)) return;
        if (props.disabled || clearing.value) return;
        readyRecordId.value = null;
        selectedRecord.value = selectedRecord.value?.id === record.id ? null : record;
    }

    function closeDetails(): void {
        selectedRecord.value = null;
        readyRecordId.value = null;
    }

    function detailsReady(record: PrivacyProtectionRecord): void {
        if (selectedRecord.value?.id === record.id) readyRecordId.value = record.id;
    }

    function resetFilters() {
        categoryFilter.value = 'all';
        modeFilter.value = 'all';
        outcomeFilter.value = 'all';
    }

    function setRange(days: RangeDays) {
        rangeDays.value = days;
        now.value = Date.now();
        resetFilters();
    }

    function localDayKey(timestamp: number): string {
        const date = new Date(timestamp);
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }

    function dayLabel(timestamp: number): string {
        const date = new Date(timestamp);
        const today = new Date(now.value);
        const yesterday = new Date(now.value - DAY_MILLIS);
        if (localDayKey(timestamp) === localDayKey(today.getTime())) {
            return t('settings.privacyFilter.records.group.today');
        }
        if (localDayKey(timestamp) === localDayKey(yesterday.getTime())) {
            return t('settings.privacyFilter.records.group.yesterday');
        }
        return new Intl.DateTimeFormat(getLocale(), {
            year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'short',
        }).format(date);
    }

    function timeLabel(timestamp: number): string {
        return new Intl.DateTimeFormat(getLocale(), {
            hour: '2-digit',
            minute: '2-digit',
        }).format(timestamp);
    }

    watch([rangeDays, categoryFilter, modeFilter, outcomeFilter], () => {
        visibleLimit.value = PAGE_SIZE;
        closeDetails();
    });
    watch(categoryOptions, (options) => {
        if (
            categoryFilter.value !== 'all' &&
            !options.some((option) => option.value === categoryFilter.value)
        ) {
            categoryFilter.value = 'all';
        }
    });

    watch(
        () => props.disabled,
        (disabled) => {
            if (disabled) closeDetails();
        }
    );

    onMounted(async () => {
        try {
            const stop = await privacyApi.onRecordsChanged(() => void refresh());
            if (unmounted) {
                stop();
                return;
            }
            unlisten = stop;
        } catch {
            log.warn('[PrivacyProtection] Could not subscribe to protection records');
        }
        if (!unmounted) await refresh();
    });

    onBeforeUnmount(() => {
        unmounted = true;
        unlisten?.();
    });
</script>

<template>
    <section
        class="space-y-4 text-settings-text"
        :aria-label="t('settings.privacyFilter.records.overview')"
        :aria-busy="loading"
    >
        <div class="space-y-2">
            <slot name="heading" />
            <div class="flex items-center justify-between gap-4">
                <slot name="description" />
                <div class="ml-auto w-32 shrink-0">
                    <CustomSelect
                        :model-value="rangeDays"
                        :options="rangeOptions"
                        :disabled="disabled || loading || clearing"
                        :aria-label="t('settings.privacyFilter.records.range.label')"
                        trigger-test-id="privacy-protection-records-range"
                        option-test-id-prefix="privacy-protection-records-range-"
                        @update:model-value="setRange"
                    />
                </div>
            </div>
        </div>
        <MetricCards :cards="summaryCards" test-id-prefix="privacy-protection-summary-" />
        <div class="rounded-control bg-metric-surface/80 p-4">
            <h3 class="mb-2 text-xs text-muted-foreground">
                {{ t('settings.privacyFilter.records.daily') }}
            </h3>
            <BarChart
                :data="dailyRecords"
                :series="chartSeries"
                :label="t('settings.privacyFilter.records.daily')"
                :height="144"
                :format-tick="
                    (value) => (Number.isInteger(value) ? value.toLocaleString(getLocale()) : '')
                "
                :legend="false"
                :show-average="false"
            />
        </div>
    </section>

    <slot />

    <section
        class="space-y-4 text-settings-text"
        data-settings-search-target="privacy-protection-records"
        aria-labelledby="privacy-protection-records-title"
    >
        <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0">
                <h2
                    id="privacy-protection-records-title"
                    class="settings-section-title text-settings-text"
                >
                    {{ t('settings.privacyFilter.records.title') }}
                </h2>
                <p class="settings-section-description">
                    {{ t('settings.privacyFilter.records.retention') }}
                </p>
            </div>
            <div class="ml-auto flex shrink-0 items-center justify-end gap-1.5">
                <div class="w-32">
                    <CustomSelect
                        v-model="categoryFilter"
                        :options="categoryOptions"
                        :disabled="disabled || loading"
                        :aria-label="t('settings.privacyFilter.records.filter.category')"
                        trigger-test-id="privacy-protection-records-category-filter"
                        option-test-id-prefix="privacy-protection-records-category-"
                    />
                </div>
                <div class="w-28">
                    <CustomSelect
                        v-model="modeFilter"
                        :options="modeOptions"
                        :disabled="disabled || loading"
                        :aria-label="t('settings.privacyFilter.records.filter.mode')"
                        trigger-test-id="privacy-protection-records-mode-filter"
                        option-test-id-prefix="privacy-protection-records-mode-"
                    />
                </div>
                <div class="w-28">
                    <CustomSelect
                        v-model="outcomeFilter"
                        :options="outcomeOptions"
                        :disabled="disabled || loading"
                        :aria-label="t('settings.privacyFilter.records.filter.outcome')"
                        trigger-test-id="privacy-protection-records-outcome-filter"
                        option-test-id-prefix="privacy-protection-records-outcome-"
                    />
                </div>
                <Button
                    variant="ghost-neutral"
                    data-testid="privacy-protection-records-clear"
                    :aria-label="t('settings.privacyFilter.records.clear')"
                    :title="t('settings.privacyFilter.records.clear')"
                    :disabled="disabled || loading || clearing || !records.length"
                    @click="clear"
                >
                    <AppIcon name="trash" class="h-4 w-4" />
                </Button>
            </div>
        </div>

        <p v-if="loadFailed" class="text-xs text-text-danger" role="alert">
            {{ t('settings.privacyFilter.records.loadFailed') }}
            <Button
                variant="ghost-neutral"
                data-testid="privacy-protection-records-retry"
                :disabled="disabled || loading || clearing"
                @click="refresh"
            >
                {{ t('common.retry') }}
            </Button>
        </p>

        <div v-if="!records.length && !loading && !loadFailed" class="settings-row-group">
            <EmptyState
                size="compact"
                icon="history"
                :title="t('settings.privacyFilter.records.empty')"
            />
        </div>
        <p
            v-else-if="!records.length && loading"
            class="px-5 py-4 text-sm text-text-secondary"
            role="status"
        >
            {{ t('common.loading') }}
        </p>
        <div v-else-if="!filteredRecords.length" class="settings-row-group">
            <EmptyState
                size="compact"
                icon="history"
                :title="t('settings.privacyFilter.records.noMatches')"
            >
                <template v-if="hasActiveFilters" #actions>
                    <Button
                        variant="outline-neutral"
                        :disabled="disabled || loading"
                        @click="resetFilters"
                    >
                        {{ t('settings.privacyFilter.records.filter.reset') }}
                    </Button>
                </template>
            </EmptyState>
        </div>
        <div v-else class="space-y-6 text-muted-foreground">
            <section v-for="group in recordGroups" :key="group.key" class="space-y-2">
                <h3 class="px-1 text-xs font-medium">
                    {{ group.label }}
                </h3>
                <div>
                    <ul class="space-y-2" :aria-label="t('settings.privacyFilter.records.title')">
                        <li
                            v-for="record in group.records"
                            :key="record.id"
                            data-testid="privacy-protection-record"
                            :data-direction="record.direction ?? 'mask'"
                            class="min-w-0 rounded-panel border border-border-subtle bg-settings-surface"
                        >
                            <button
                                type="button"
                                class="flex min-h-12 w-full items-center gap-3 rounded-panel px-4 py-3 text-left focus-visible:bg-surface-hover focus-visible:underline focus-visible:underline-offset-4 disabled:cursor-not-allowed"
                                data-testid="privacy-protection-record-open"
                                :aria-expanded="
                                    detailsAvailable(record) && selectedRecord?.id === record.id
                                "
                                :aria-controls="
                                    detailsAvailable(record)
                                        ? `privacy-protection-details-${record.id}`
                                        : undefined
                                "
                                :aria-disabled="!detailsAvailable(record) || undefined"
                                :tabindex="detailsAvailable(record) ? undefined : -1"
                                :disabled="disabled || clearing"
                                :aria-busy="
                                    selectedRecord?.id === record.id && readyRecordId !== record.id
                                "
                                @click="openRecord(record)"
                            >
                                <div class="flex min-w-0 flex-1 flex-col gap-1">
                                    <span class="flex min-w-0 items-center gap-2">
                                        <ModelLogo
                                            :model-id="record.modelName ?? ''"
                                            :name="record.modelName"
                                            size="xs"
                                        />
                                        <span
                                            class="min-w-0 truncate text-dense text-settings-text"
                                        >
                                            {{ sessionTitle(record) }}
                                        </span>
                                    </span>
                                    <span
                                        class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-caption"
                                        data-testid="privacy-protection-record-meta"
                                    >
                                        <span>
                                            {{
                                                record.modelName ||
                                                t('settings.privacyFilter.records.unknownModel')
                                            }}
                                        </span>
                                        <span>{{ modeAndCategories(record) }}</span>
                                    </span>
                                </div>
                                <span class="flex shrink-0 items-center gap-2 text-caption">
                                    <span
                                        v-if="record.outcome === 'protected'"
                                        class="flex items-center gap-1 font-medium tabular-nums"
                                        data-testid="privacy-protection-record-count"
                                    >
                                        <AppIcon name="shield-check" class="h-3 w-3 shrink-0" />
                                        <span>
                                            {{
                                                t(
                                                    record.direction === 'restore'
                                                        ? 'settings.privacyFilter.records.restoredShort'
                                                        : 'settings.privacyFilter.records.protectedShort',
                                                    {
                                                        count: record.maskedCount.toLocaleString(
                                                            getLocale()
                                                        ),
                                                    }
                                                )
                                            }}
                                        </span>
                                    </span>
                                    <span v-else>
                                        {{ t('settings.privacyFilter.records.blockedShort') }}
                                    </span>
                                    <time class="tabular-nums">
                                        {{ timeLabel(record.createdAt) }}
                                    </time>
                                </span>
                                <span
                                    class="flex h-4 w-4 shrink-0 items-center justify-center"
                                    aria-hidden="true"
                                >
                                    <AppIcon
                                        v-if="
                                            selectedRecord?.id === record.id &&
                                            readyRecordId !== record.id
                                        "
                                        name="loading"
                                        class="h-4 w-4 animate-spin"
                                        data-testid="privacy-protection-record-loading"
                                    />
                                    <AppIcon
                                        v-else-if="detailsAvailable(record)"
                                        data-testid="privacy-protection-record-chevron"
                                        name="chevron-right"
                                        class="h-4 w-4 transition-transform"
                                        :class="selectedRecord?.id === record.id && 'rotate-90'"
                                    />
                                </span>
                            </button>
                            <motion.div
                                v-if="selectedRecord?.id === record.id"
                                :id="`privacy-protection-details-${record.id}`"
                                class="overflow-hidden"
                                :initial="{ height: 0, opacity: 0 }"
                                :animate="
                                    readyRecordId === record.id
                                        ? { height: 'auto', opacity: 1 }
                                        : { height: 0, opacity: 0 }
                                "
                                :transition="transitions.fast"
                                data-testid="privacy-protection-record-expansion"
                            >
                                <PrivacyProtectionDetails
                                    :record="record"
                                    @ready="detailsReady(record)"
                                />
                            </motion.div>
                        </li>
                    </ul>
                </div>
            </section>
        </div>
        <div v-if="visibleLimit < filteredRecords.length" class="flex justify-center">
            <Button
                variant="ghost-neutral"
                data-testid="privacy-protection-records-more"
                :disabled="disabled"
                @click="visibleLimit += PAGE_SIZE"
            >
                {{ t('settings.privacyFilter.records.more') }}
            </Button>
        </div>
    </section>
</template>
