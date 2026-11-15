<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import EmptyState from '@components/EmptyState.vue';
    import MotionCollapse from '@components/MotionCollapse.vue';
    import AnimatedCounter from '@components/ui/animated-counter/AnimatedCounter.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import { native } from '@services/NativeService';
    import {
        PRIVACY_FILTER_RECORDS_CHANGED_EVENT,
        PRIVACY_FILTER_RECORDS_LIMIT,
        PRIVACY_FILTER_RECORDS_RETENTION_DAYS,
        type PrivacyProtectionKind,
        type PrivacyProtectionRecord,
    } from '@services/NativeService/privacyFilter';
    import { log } from '@services/ObservabilityService';
    import { listen, type UnlistenFn } from '@tauri-apps/api/event';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { getLocale, t } from '@/i18n';

    import PrivacyProtectionDetails from './PrivacyProtectionDetails.vue';
    import { privacyProtectionKindLabels as kindLabels } from './privacyProtectionLabels';

    const props = defineProps<{ disabled: boolean }>();
    type RangeDays = 7 | typeof PRIVACY_FILTER_RECORDS_RETENTION_DAYS;
    type CategoryFilter = 'all' | PrivacyProtectionKind;
    type ModeFilter = 'all' | 'model' | 'rules';
    type OutcomeFilter = 'all' | 'protected' | 'blocked';
    const DAY_MILLIS = 24 * 60 * 60 * 1_000;
    const PAGE_SIZE = 20;
    const records = ref<PrivacyProtectionRecord[]>([]);
    const selectedRecord = ref<PrivacyProtectionRecord | null>(null);
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
    const alert = useAlert();
    let unlisten: UnlistenFn | undefined;
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

    const recordsInRange = computed(() => {
        const cutoff = now.value - rangeDays.value * DAY_MILLIS;
        return records.value.filter((record) => record.createdAt >= cutoff);
    });
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
                label: `${t(kindLabels[kind])} · ${categoryCounts.value.get(kind)}`,
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
        requests: recordsInRange.value.length,
        protectedCount: recordsInRange.value.reduce(
            (total, record) => total + record.maskedCount,
            0
        ),
        blockedCount: recordsInRange.value.filter((record) => record.outcome === 'blocked').length,
    }));
    const summaryCards = computed(() => [
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
    const peakMaskedCount = computed(() =>
        Math.max(1, ...filteredRecords.value.map((record) => record.maskedCount))
    );
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

    async function refresh() {
        const sequence = ++requestSequence;
        loading.value = true;
        try {
            const next = await native.privacyFilter.getRecords();
            if (unmounted || sequence !== requestSequence) return;
            records.value = next;
            if (
                selectedRecord.value &&
                !next.some((record) => record.id === selectedRecord.value?.id)
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
            await native.privacyFilter.clearRecords();
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
        if (props.disabled || clearing.value) return;
        selectedRecord.value = selectedRecord.value?.id === record.id ? null : record;
    }

    function closeDetails(): void {
        selectedRecord.value = null;
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

    function details(record: PrivacyProtectionRecord): string {
        return `${timeLabel(record.createdAt)} · ${t(record.mode === 'model' ? 'settings.privacyFilter.mode.model' : 'settings.privacyFilter.mode.rules')}`;
    }

    function barWidth(record: PrivacyProtectionRecord): string {
        return `${Math.max(1, (record.maskedCount / peakMaskedCount.value) * 100)}%`;
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
            const stop = await listen(PRIVACY_FILTER_RECORDS_CHANGED_EVENT, () => void refresh());
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
        class="space-y-4"
        data-settings-search-target="privacy-protection-records"
        aria-labelledby="privacy-protection-records-title"
    >
        <div class="flex items-start gap-4">
            <div class="min-w-0">
                <h2 id="privacy-protection-records-title" class="settings-section-title">
                    {{ t('settings.privacyFilter.records.title') }}
                </h2>
                <p class="settings-section-description">
                    {{
                        t('settings.privacyFilter.records.retention', {
                            days: PRIVACY_FILTER_RECORDS_RETENTION_DAYS,
                            count: PRIVACY_FILTER_RECORDS_LIMIT,
                        })
                    }}
                </p>
            </div>
            <div class="ml-auto flex shrink-0 items-center gap-1.5">
                <div class="w-28">
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

        <div class="grid grid-cols-3 gap-3">
            <div
                v-for="card in summaryCards"
                :key="card.key"
                class="flex min-w-0 flex-col gap-1 rounded-control bg-surface-raised px-4 py-3"
            >
                <span class="truncate text-xs text-text-secondary">{{ card.label }}</span>
                <span
                    class="truncate font-serif text-title leading-tight font-semibold text-text-primary tabular-nums"
                    :data-testid="`privacy-protection-summary-${card.key}`"
                    :aria-label="String(card.value)"
                    :data-value="card.value"
                >
                    <AnimatedCounter
                        :value="card.value"
                        :animate-on-view="true"
                        :locale="getLocale()"
                    />
                </span>
            </div>
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
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
        <div v-else class="space-y-3">
            <section v-for="group in recordGroups" :key="group.key" class="space-y-2">
                <h3 class="px-1 text-xs font-medium text-text-secondary">
                    {{ group.label }}
                </h3>
                <div class="rounded-control bg-surface-raised p-3">
                    <ul :aria-label="t('settings.privacyFilter.records.title')">
                        <li
                            v-for="record in group.records"
                            :key="record.id"
                            data-testid="privacy-protection-record"
                            class="min-w-0 rounded-action"
                        >
                            <button
                                type="button"
                                class="flex min-h-11 w-full items-center gap-2.5 rounded-action px-2 py-1.5 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed"
                                data-testid="privacy-protection-record-open"
                                :title="details(record)"
                                :aria-expanded="selectedRecord?.id === record.id"
                                :aria-controls="`privacy-protection-details-${record.id}`"
                                :disabled="disabled || clearing"
                                @click="openRecord(record)"
                            >
                                <div class="w-1/3 min-w-0 shrink-0">
                                    <div class="truncate text-dense text-text-primary">
                                        {{
                                            record.outcome === 'blocked'
                                                ? t('settings.privacyFilter.records.blocked')
                                                : t('settings.privacyFilter.records.protected', {
                                                      count: record.maskedCount,
                                                  })
                                        }}
                                    </div>
                                    <div class="truncate text-caption text-text-tertiary">
                                        {{
                                            t(
                                                record.mode === 'model'
                                                    ? 'settings.privacyFilter.mode.model'
                                                    : 'settings.privacyFilter.mode.rules'
                                            )
                                        }}
                                    </div>
                                </div>
                                <div
                                    class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border-subtle"
                                >
                                    <div
                                        class="h-full rounded-full"
                                        :class="
                                            record.outcome === 'blocked'
                                                ? 'bg-text-warning'
                                                : 'bg-text-secondary'
                                        "
                                        :style="{ width: barWidth(record) }"
                                    />
                                </div>
                                <div class="hidden max-w-56 shrink-0 justify-end gap-1 sm:flex">
                                    <Badge
                                        v-for="category in record.categories.slice(0, 2)"
                                        :key="category.kind"
                                        variant="tag"
                                        size="sm"
                                        tone="gray"
                                    >
                                        {{ t(kindLabels[category.kind]) }} {{ category.count }}
                                    </Badge>
                                    <Badge
                                        v-if="record.categories.length > 2"
                                        variant="tag"
                                        size="sm"
                                        tone="gray"
                                    >
                                        +{{ record.categories.length - 2 }}
                                    </Badge>
                                </div>
                                <span
                                    class="w-12 shrink-0 text-right text-dense text-text-secondary"
                                >
                                    <span class="tabular-nums">
                                        {{ timeLabel(record.createdAt) }}
                                    </span>
                                </span>
                                <AppIcon
                                    name="chevron-right"
                                    class="h-4 w-4 shrink-0 text-text-tertiary transition-transform"
                                    :class="selectedRecord?.id === record.id && 'rotate-90'"
                                    aria-hidden="true"
                                />
                            </button>
                            <MotionCollapse
                                :id="`privacy-protection-details-${record.id}`"
                                :open="selectedRecord?.id === record.id"
                                lazy
                            >
                                <PrivacyProtectionDetails
                                    v-if="selectedRecord?.id === record.id"
                                    :record="record"
                                />
                            </MotionCollapse>
                        </li>
                    </ul>
                </div>
            </section>
        </div>
        <Button
            v-if="visibleLimit < filteredRecords.length"
            variant="outline-neutral"
            :disabled="disabled"
            @click="visibleLimit += PAGE_SIZE"
        >
            {{ t('settings.privacyFilter.records.more') }}
        </Button>
    </section>
</template>
