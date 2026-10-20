<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import LoadingState from '@components/LoadingState.vue';
    import {
        canUseUsageArchive,
        type ContextProfile,
        getContextProfiles,
        getToolUsageStats,
        getUsageFilterOptions,
        getUsageHeatmap,
        getUsageSummary,
        getUsageTrend,
        getUsageTrendFromArchive,
        type ToolUsageSummary,
        type UsageFilter,
        type UsageFilterOptions,
        type UsageHeatmapDay,
        type UsageRangePreset,
        type UsageSummary,
        type UsageTrendPoint,
    } from '@database/queries';
    import { AppEvent, eventService } from '@services/EventService';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import UsageChart from './components/UsageChart.vue';
    import UsageContext from './components/UsageContext.vue';
    import UsageDashboard from './components/UsageDashboard.vue';
    import UsageHeatmap from './components/UsageHeatmap.vue';
    import UsageToolbar from './components/UsageToolbar.vue';
    import UsageToolStats from './components/UsageToolStats.vue';
    import { resolveUsageRange } from './utils/usageRange';

    defineOptions({ name: 'SettingsUsageSection' });

    type StatusValue = 'all' | 'completed' | 'failed' | 'cancelled' | 'retried';
    type Dimension = 'model' | 'provider';

    const preset = ref<UsageRangePreset>('30d');
    const status = ref<StatusValue>('all');
    const modelId = ref<number | null>(null);
    const providerId = ref<number | null>(null);
    const search = ref('');
    const dimension = ref<Dimension>('model');

    const loading = ref(true);
    const loadError = ref(false);

    const summary = ref<UsageSummary | null>(null);
    const trend = ref<{ bucket: 'hour' | 'day'; points: UsageTrendPoint[] }>({
        bucket: 'day',
        points: [],
    });
    const heatmap = ref<UsageHeatmapDay[]>([]);
    const options = ref<UsageFilterOptions>({ models: [], providers: [] });
    const contextProfiles = ref<{ overall: ContextProfile | null; models: ContextProfile[] }>({
        overall: null,
        models: [],
    });
    const toolStats = ref<ToolUsageSummary>({
        totalCount: 0,
        errorCount: 0,
        distinctTools: 0,
        meanDurationMs: null,
        byTool: [],
    });

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let unlistenTaskStatus: (() => void) | null = null;

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
        loading.value = true;
        loadError.value = false;
        try {
            const current = filter.value;
            // 「全部时间」且无筛选时优先用永久保留的日汇总表：
            // 清理过会话轮次后，历史曲线仍然完整。
            // 汇总表为空（例如首次启动还没跑维护）时回退到实时查询，
            // 避免出现「指标有数、图表空白」的矛盾。
            const useArchive = preset.value === 'all' && canUseUsageArchive(current);
            const archiveTrend = useArchive ? await getUsageTrendFromArchive() : null;

            const [nextSummary, nextTrend, nextOptions, nextContext, nextTools, nextHeatmap] =
                await Promise.all([
                    getUsageSummary(current),
                    archiveTrend && archiveTrend.points.length > 0
                        ? archiveTrend
                        : getUsageTrend(current, dimension.value),
                    getUsageFilterOptions(current),
                    getContextProfiles(current),
                    getToolUsageStats(current),
                    getUsageHeatmap(),
                ]);

            summary.value = nextSummary;
            trend.value = nextTrend;
            options.value = nextOptions;
            contextProfiles.value = nextContext;
            toolStats.value = nextTools;
            heatmap.value = nextHeatmap;
        } catch (error) {
            console.error('[SettingsUsageSection] Failed to load usage stats:', error);
            loadError.value = true;
        } finally {
            loading.value = false;
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
    // 维度切换只影响图表分组，不必重算其它查询
    watch(dimension, () => void load());

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
                unlistenTaskStatus = unlisten;
            });
    });

    onUnmounted(() => {
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

            <LoadingState v-else-if="loading && !summary" variant="brand" fill="min" />

            <template v-else-if="summary">
                <!-- 实时面板放在“有无历史数据”之外：首轮对话进行中就该看得到 -->
                <!-- 概览与实时合并为一块：有流时显示这一轮，否则显示区间汇总 -->
                <UsageDashboard :summary="summary" />

                <div
                    v-if="summary.requestCount === 0"
                    class="settings-row-group px-5 py-16 text-center"
                    data-testid="settings-usage-empty"
                >
                    <p class="text-sm text-neutral-500">{{ t('settings.usage.empty.title') }}</p>
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

                    <UsageToolStats :stats="toolStats" />

                    <UsageHeatmap :days="heatmap" />

                    <UsageContext
                        :overall="contextProfiles.overall"
                        :models="contextProfiles.models"
                    />
                </template>
            </template>
        </div>
    </div>
</template>
