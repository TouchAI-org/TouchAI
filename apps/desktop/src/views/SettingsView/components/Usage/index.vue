<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import LoadingState from '@components/LoadingState.vue';
    import {
        canUseUsageArchive,
        type ContextProfile,
        getContextProfiles,
        getUsageByModel,
        getUsageByProvider,
        getUsageCallPage,
        getUsageFilterOptions,
        getUsageSummary,
        getUsageTrend,
        getUsageTrendFromArchive,
        type UsageCallRow,
        type UsageFilter,
        type UsageFilterOptions,
        type UsageGroup,
        type UsageRangePreset,
        type UsageSummary,
        type UsageTrendPoint,
    } from '@database/queries';
    import { AppEvent, eventService } from '@services/EventService';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import UsageBreakdown from './components/UsageBreakdown.vue';
    import UsageCallList from './components/UsageCallList.vue';
    import UsageContext from './components/UsageContext.vue';
    import UsageOverview from './components/UsageOverview.vue';
    import UsageToolbar from './components/UsageToolbar.vue';
    import { resolveUsageRange } from './utils/usageRange';

    defineOptions({ name: 'SettingsUsageSection' });

    type StatusValue = 'all' | 'completed' | 'failed' | 'cancelled' | 'retried';

    const PAGE_SIZE = 20;

    const preset = ref<UsageRangePreset>('30d');
    const status = ref<StatusValue>('all');
    const modelId = ref<number | null>(null);
    const providerId = ref<number | null>(null);
    const search = ref('');
    const callOffset = ref(0);

    const loading = ref(true);
    const loadError = ref(false);

    const summary = ref<UsageSummary | null>(null);
    const trend = ref<{ bucket: 'hour' | 'day'; points: UsageTrendPoint[] }>({
        bucket: 'day',
        points: [],
    });
    const byModel = ref<UsageGroup[]>([]);
    const byProvider = ref<UsageGroup[]>([]);
    const options = ref<UsageFilterOptions>({ models: [], providers: [] });
    const calls = ref<{ rows: UsageCallRow[]; total: number }>({ rows: [], total: 0 });
    const contextProfiles = ref<{ overall: ContextProfile | null; models: ContextProfile[] }>({
        overall: null,
        models: [],
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
            // 避免出现「指标有数、趋势空白」的矛盾。
            const useArchive = preset.value === 'all' && canUseUsageArchive(current);
            const archiveTrend = useArchive ? await getUsageTrendFromArchive() : null;
            const [
                nextSummary,
                nextTrend,
                nextModels,
                nextProviders,
                nextOptions,
                nextCalls,
                nextContext,
            ] = await Promise.all([
                getUsageSummary(current),
                archiveTrend && archiveTrend.points.length > 0
                    ? archiveTrend
                    : getUsageTrend(current),
                getUsageByModel(current),
                getUsageByProvider(current),
                getUsageFilterOptions(current),
                getUsageCallPage(current, callOffset.value, PAGE_SIZE),
                getContextProfiles(current),
            ]);

            summary.value = nextSummary;
            trend.value = nextTrend;
            byModel.value = nextModels;
            byProvider.value = nextProviders;
            options.value = nextOptions;
            calls.value = { rows: nextCalls.rows, total: nextCalls.total };
            contextProfiles.value = nextContext;
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

    watch(
        filter,
        () => {
            callOffset.value = 0;
            void load();
        },
        { deep: true }
    );

    watch(callOffset, () => void load());

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
            <!-- 标题与筛选同排，筛选靠右 -->
            <header class="settings-page-header">
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <h1 class="settings-page-title">{{ t('settings.nav.usage.label') }}</h1>
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
                    <UsageOverview :summary="summary" :trend="trend" />

                    <UsageBreakdown
                        :by-model="byModel"
                        :by-provider="byProvider"
                        :selected-model-id="modelId"
                        :selected-provider-id="providerId"
                        @select-model="modelId = $event"
                        @select-provider="providerId = $event"
                    />

                    <UsageContext
                        :overall="contextProfiles.overall"
                        :models="contextProfiles.models"
                    />

                    <section class="space-y-3" data-testid="settings-usage-calls">
                        <h2 class="settings-section-title">{{ t('settings.usage.call.title') }}</h2>
                        <UsageCallList
                            :rows="calls.rows"
                            :total="calls.total"
                            :offset="callOffset"
                            :limit="PAGE_SIZE"
                            :loading="loading"
                            @change-page="callOffset = $event"
                        />
                    </section>
                </template>
            </template>
        </div>
    </div>
</template>
