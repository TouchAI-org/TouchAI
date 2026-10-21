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
    const trend = ref<{ bucket: UsageBucket; points: UsageTrendPoint[] }>({
        bucket: 'day',
        points: [],
    });
    const heatmap = ref<UsageHeatmapDay[]>([]);
    const options = ref<UsageFilterOptions>({ models: [], providers: [] });
    /** 两个排行各自的指标维度 */
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
    /** 工具统计是否已到（空数据也要展示空态，不能当成未加载） */
    const toolsReady = ref(false);
    /** 两个排行是否已到 */
    const rankingsReady = ref(false);

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

            // 第一阶段：只取首屏（汇总 + 曲线），先把仪表盘渲染出来。
            // 其余区块都是独立查询，没必让首屏陪着一起等。
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
            // 首屏已就绪，后续区块可以各自显示自己的加载态
            loading.value = false;

            // 第二阶段：其余区块并行填充（含「全部时间」的归档趋势）。
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

            // 即时查询覆盖仍有明细的日期；归档只补回已清理的历史日期。
            const nextTrend = dashboard.trend;
            if (archiveTrend && nextTrend.bucket === 'day') {
                const rawKeys = new Set(nextTrend.points.map((point) => point.key));
                trend.value = {
                    bucket: 'day',
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
            console.error('[SettingsUsageSection] Failed to load usage stats:', error);
            if (version === loadVersion && !disposed) loadError.value = true;
        } finally {
            if (version === loadVersion && !disposed) loading.value = false;
        }
    }

    /** 事件驱动的实时刷新：任务结束后延迟合并，避免短暂加载态 */
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

        // 对话完成/失败/取消后自动刷新，用量页不提供手动刷新按钮
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
                :live-turns="liveTurns"
                :range="{ preset, ...loadedRange }"
                @track-tasks="trackTasks"
            />
            <UsageDashboardSkeleton v-else />

            <template v-if="summary">
                <div
                    v-if="summary.requestCount === 0"
                    class="settings-row-group px-5 py-16 text-center"
                    data-testid="settings-usage-empty"
                >
                    <p class="text-sm text-neutral-500">
                        {{ t('settings.usage.empty.title') }}
                    </p>
                    <p class="mt-1 text-xs text-neutral-400">
                        {{ t('settings.usage.empty.body') }}
                    </p>
                </div>

                <template v-else>
                    <UsageChart
                        :points="trend.points"
                        :bucket="trend.bucket"
                        :dimension="dimension"
                        @update:dimension="dimension = $event"
                    />

                    <!-- 各区块自带骨架：数据未到时组件内部画占位，不再由外部拼接 -->
                    <UsageComposition :composition="composition" />

                    <UsageToolStats :stats="toolStats" :loading="!toolsReady" />

                    <!-- 两个排行并排一行；窄屏自动堆叠 -->
                    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        <UsageRanking
                            :title="t('settings.usage.ranking.modelTitle')"
                            :items="modelRanking"
                            :metric="modelRankMetric"
                            :loading="!rankingsReady"
                            @update:metric="modelRankMetric = $event"
                        />
                        <UsageRanking
                            :title="t('settings.usage.ranking.sessionTitle')"
                            :items="sessionRanking"
                            :metric="sessionRankMetric"
                            supports-duration
                            :loading="!rankingsReady"
                            @update:metric="sessionRankMetric = $event"
                        />
                    </div>

                    <!-- 热力图固定展示近一年，不再跟随筛选区间，只影响深浅 -->
                    <UsageHeatmap :days="heatmap" />
                </template>
            </template>
        </div>
    </div>
</template>
