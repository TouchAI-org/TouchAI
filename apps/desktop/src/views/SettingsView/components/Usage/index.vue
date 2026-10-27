<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import {
        canUseUsageArchive,
        getModelRanking,
        getSessionRanking,
        getToolUsageStats,
        getUsageComposition,
        getUsageDashboardSnapshot,
        getUsageFilterOptions,
        getUsageHeatmap,
        getUsageTrendFromArchive,
        type ToolUsageSummary,
        type UsageBucket,
        type UsageComposition as UsageCompositionData,
        type UsageFilter,
        type UsageFilterOptions,
        type UsageHeatmapDay,
        type UsageLiveTurn,
        type UsageRangePreset,
        type UsageRankItem,
        type UsageRankMetric,
        type UsageSummary,
        type UsageTrendPoint,
    } from '@database/queries';
    import { AppEvent, eventService } from '@services/EventService';
    import { log } from '@services/ObservabilityService';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import UsageChart from './components/UsageChart.vue';
    import UsageComposition from './components/UsageComposition.vue';
    import UsageDashboard from './components/UsageDashboard.vue';
    import UsageDashboardSkeleton from './components/UsageDashboardSkeleton.vue';
    import UsageHeatmap from './components/UsageHeatmap.vue';
    import UsageRanking from './components/UsageRanking.vue';
    import UsageToolbar from './components/UsageToolbar.vue';
    import UsageToolStats from './components/UsageToolStats.vue';
    import { resolveUsageRange } from './utils/usageRange';

    defineOptions({ name: 'SettingsUsageSection' });

    type StatusValue = 'all' | 'completed' | 'failed' | 'cancelled' | 'retried';
    type Dimension = 'model' | 'provider';

    const preset = ref<UsageRangePreset>('today');
    const status = ref<StatusValue>('all');
    const modelId = ref<number | null>(null);
    const providerId = ref<number | null>(null);
    const search = ref('');
    const dimension = ref<Dimension>('model');

    const loading = ref(true);
    const loadError = ref(false);

    const summary = ref<UsageSummary | null>(null);
    const liveTurns = ref<UsageLiveTurn[]>([]);
    const trackedTaskIds = ref<string[]>([]);
    const loadedRange = ref(resolveUsageRange(preset.value));
    const trend = ref<{ bucket: UsageBucket; bucketMs: number; points: UsageTrendPoint[] }>({
        bucket: 'day',
        bucketMs: 86_400_000,
        points: [],
    });
    const heatmap = ref<UsageHeatmapDay[]>([]);
    const options = ref<UsageFilterOptions>({ models: [], providers: [] });
    /** Metric dimension of each ranking. */
    const modelRankMetric = ref<UsageRankMetric>('tokens');
    const sessionRankMetric = ref<UsageRankMetric>('duration');
    const modelRanking = ref<UsageRankItem[]>([]);
    const sessionRanking = ref<UsageRankItem[]>([]);
    const composition = ref<UsageCompositionData | null>(null);
    const toolStats = ref<ToolUsageSummary>({
        totalCount: 0,
        errorCount: 0,
        distinctTools: 0,
        meanDurationMs: null,
        byTool: [],
    });
    /** Tool stats arrived; empty data still renders an empty state, not a loader. */
    const toolsReady = ref(false);
    /** Both rankings arrived. */
    const rankingsReady = ref(false);

    /**
     * Row count shared by both rankings.
     *
     * Takes the taller side, capped at four rows: two single-row sides stay
     * single-row instead of padding three empty skeletons, while a seven-row
     * side against a two-row side caps at four and pads the shorter one so the
     * pair lines up, with the excess scrolling inside.
     */
    const rankingRows = computed(() =>
        Math.min(Math.max(modelRanking.value.length, sessionRanking.value.length), 4)
    );

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let unlistenTaskStatus: (() => void) | null = null;
    let loadVersion = 0;
    let disposed = false;

    const filter = computed<UsageFilter>(() => {
        const base = resolveUsageRange(preset.value);
        return {
            ...base,
            modelIds: modelId.value === null ? undefined : [modelId.value],
            providerIds: providerId.value === null ? undefined : [providerId.value],
            statuses:
                status.value === 'all' || status.value === 'retried' ? undefined : [status.value],
            onlyFailed: status.value === 'failed',
            onlyRetried: status.value === 'retried',
            search: search.value.trim() || undefined,
        };
    });

    async function load() {
        const version = ++loadVersion;
        loading.value = true;
        loadError.value = false;
        try {
            const current = { ...filter.value, ...resolveUsageRange(preset.value) };

            // Phase one: the above-the-fold snapshot only, so the dashboard
            // renders immediately. The blocks below run their own queries and
            // do not need to hold it up.
            const dashboard = await getUsageDashboardSnapshot(
                current,
                trackedTaskIds.value,
                dimension.value
            );
            if (version !== loadVersion || disposed) return;

            summary.value = dashboard.summary;
            liveTurns.value = dashboard.liveTurns;
            loadedRange.value = { from: current.from, to: current.to };
            trend.value = dashboard.trend;
            // The above-the-fold content is ready; each block below can show
            // its own loading state from here on.
            loading.value = false;

            // Phase two: fill the remaining blocks in parallel, including the
            // archived trend for "all time".
            const useArchive = preset.value === 'all' && canUseUsageArchive(current);
            const [
                archiveTrend,
                nextOptions,
                nextComposition,
                nextTools,
                nextHeatmap,
                nextModelRanking,
                nextSessionRanking,
            ] = await Promise.all([
                useArchive ? getUsageTrendFromArchive() : Promise.resolve(null),
                getUsageFilterOptions(current),
                getUsageComposition(current),
                getToolUsageStats(current),
                getUsageHeatmap(current),
                getModelRanking(current, modelRankMetric.value),
                getSessionRanking(current, sessionRankMetric.value),
            ]);

            if (version !== loadVersion || disposed) return;

            // Live queries cover days that still have detail rows; the archive
            // only fills in days that were already pruned.
            const nextTrend = dashboard.trend;
            if (archiveTrend && nextTrend.bucket === 'day') {
                const rawKeys = new Set(nextTrend.points.map((point) => point.key));
                trend.value = {
                    bucket: 'day',
                    bucketMs: 86_400_000,
                    points: [
                        ...archiveTrend.points.filter((point) => !rawKeys.has(point.key)),
                        ...nextTrend.points,
                    ].sort((left, right) => left.key.localeCompare(right.key)),
                };
            }
            options.value = nextOptions;
            composition.value = nextComposition;
            toolStats.value = nextTools;
            toolsReady.value = true;
            rankingsReady.value = true;
            heatmap.value = nextHeatmap;
            modelRanking.value = nextModelRanking;
            sessionRanking.value = nextSessionRanking;
        } catch (error) {
            log.error('[SettingsUsageSection] Failed to load usage stats:', error);
            if (version === loadVersion && !disposed) loadError.value = true;
        } finally {
            if (version === loadVersion && !disposed) loading.value = false;
        }
    }

    /** Event-driven refresh: debounce after a task ends to avoid a loading flash. */
    function scheduleRefresh() {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
            void load();
        }, 350);
    }

    watch(filter, () => void load(), { deep: true });
    watch([dimension, modelRankMetric, sessionRankMetric], () => void load());

    function trackTasks(taskIds: string[]) {
        trackedTaskIds.value = taskIds;
        scheduleRefresh();
    }

    onMounted(() => {
        void load();

        // Refresh automatically once a conversation completes, fails, or is
        // cancelled. This page has no manual refresh control.
        void eventService
            .on(AppEvent.SESSION_TASK_STATUS_CHANGED, (payload) => {
                if (
                    payload.status === 'completed' ||
                    payload.status === 'failed' ||
                    payload.status === 'cancelled'
                ) {
                    scheduleRefresh();
                }
            })
            .then((unlisten) => {
                if (disposed) unlisten();
                else unlistenTaskStatus = unlisten;
            });
    });

    onUnmounted(() => {
        disposed = true;
        loadVersion += 1;
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        unlistenTaskStatus?.();
        unlistenTaskStatus = null;
    });
</script>

<template>
    <div class="settings-page" data-testid="settings-usage-section">
        <div class="settings-section-stack">
            <!-- 标题与筛选同排，筛选靠右；不换行，避免筛选一变布局就跳 -->
            <header class="settings-page-header !mb-6">
                <div class="flex items-center justify-between gap-3">
                    <h1 class="settings-page-title shrink-0">
                        {{ t('settings.nav.usage.label') }}
                    </h1>
                    <UsageToolbar
                        :preset="preset"
                        :status="status"
                        :provider-id="providerId"
                        :model-id="modelId"
                        :search="search"
                        :options="options"
                        :loading="loading"
                        @update:preset="preset = $event"
                        @update:status="status = $event"
                        @update:provider-id="providerId = $event"
                        @update:model-id="modelId = $event"
                        @update:search="search = $event"
                    />
                </div>
            </header>

            <div v-if="loadError" class="settings-card text-red-700">
                {{ t('settings.usage.loadFailed') }}
            </div>

            <!-- 首屏骨架只覆盖仪表盘；下方各区块在组件内部各自处理加载态 -->
            <UsageDashboard
                v-if="summary"
                :summary="summary"
                :trend="trend.points"
                :bucket="trend.bucket"
                :bucket-ms="trend.bucketMs"
                :live-turns="liveTurns"
                :range="{ preset, ...loadedRange }"
                @track-tasks="trackTasks"
            />
            <UsageDashboardSkeleton v-else />

            <!-- 无数据时下方不渲染任何区块，仪表盘自带的「0 个会话」已说明情况 -->
            <template v-if="summary && summary.requestCount > 0">
                <UsageChart
                    :points="trend.points"
                    :bucket="trend.bucket"
                    :bucket-ms="trend.bucketMs"
                    :dimension="dimension"
                    @update:dimension="dimension = $event"
                />

                <!-- 各区块自带骨架：数据未到时组件内部画占位，不再由外部拼接 -->
                <UsageComposition :composition="composition" />

                <UsageToolStats :stats="toolStats" :loading="!toolsReady" />

                <!-- 两个排行并排；高度取「两侧较多行数」与四行中的较大值，空缺处用骨架补齐 -->
                <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <UsageRanking
                        :title="t('settings.usage.ranking.modelTitle')"
                        :items="modelRanking"
                        :metric="modelRankMetric"
                        :loading="!rankingsReady"
                        :height-rows="rankingRows"
                        :selected-id="modelId"
                        @update:metric="modelRankMetric = $event"
                        @select="modelId = $event"
                    />
                    <UsageRanking
                        :title="t('settings.usage.ranking.sessionTitle')"
                        :items="sessionRanking"
                        :metric="sessionRankMetric"
                        supports-duration
                        :loading="!rankingsReady"
                        :height-rows="rankingRows"
                        @update:metric="sessionRankMetric = $event"
                    />
                </div>

                <!-- 热力图固定展示近一年，不再跟随筛选区间，只影响深浅 -->
                <UsageHeatmap :days="heatmap" />
            </template>
        </div>
    </div>
</template>
