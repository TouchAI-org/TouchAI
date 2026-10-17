<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import {
        getUsageByModel,
        getUsageByProvider,
        getUsageCallPage,
        getUsageFilterOptions,
        getUsageHeatmap,
        getUsageSummary,
        getUsageTrend,
        type UsageCallRow,
        type UsageFilter,
        type UsageFilterOptions,
        type UsageGroup,
        type UsageHeatmapDay,
        type UsageRangePreset,
        type UsageSummary,
        type UsageTrendPoint,
    } from '@database/queries';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { type MessageKey, t } from '@/i18n';

    import UsageCallTable from './components/UsageCallTable.vue';
    import UsageFilters from './components/UsageFilters.vue';
    import UsageGroupList from './components/UsageGroupList.vue';
    import UsageHeatmap from './components/UsageHeatmap.vue';
    import UsageHero from './components/UsageHero.vue';
    import UsageTrendChart from './components/UsageTrendChart.vue';
    import { resolveUsageRange } from './utils/usageRange';

    defineOptions({ name: 'SettingsUsageSection' });

    type UsageTab = 'overview' | 'calls' | 'models' | 'providers';

    const TABS: Array<{ value: UsageTab; labelKey: MessageKey }> = [
        { value: 'overview', labelKey: 'settings.usage.tab.overview' },
        { value: 'calls', labelKey: 'settings.usage.tab.calls' },
        { value: 'models', labelKey: 'settings.usage.tab.models' },
        { value: 'providers', labelKey: 'settings.usage.tab.providers' },
    ];

    const PAGE_SIZE = 50;

    const preset = ref<UsageRangePreset>('7d');
    const modelIds = ref<number[]>([]);
    const providerIds = ref<number[]>([]);
    const statuses = ref<UsageFilter['statuses']>(undefined);
    const search = ref('');
    const activeTab = ref<UsageTab>('overview');
    const callOffset = ref(0);

    const loading = ref(true);
    const loadError = ref<string | null>(null);

    const summary = ref<UsageSummary | null>(null);
    const trend = ref<{ bucket: 'hour' | 'day'; points: UsageTrendPoint[] }>({
        bucket: 'day',
        points: [],
    });
    const heatmap = ref<UsageHeatmapDay[]>([]);
    const byModel = ref<UsageGroup[]>([]);
    const byProvider = ref<UsageGroup[]>([]);
    const options = ref<UsageFilterOptions>({ models: [], providers: [] });
    const calls = ref<UsageCallRow[]>([]);
    const callTotal = ref(0);

    const containerRef = ref<HTMLElement | null>(null);
    const containerWidth = ref(0);
    let observer: ResizeObserver | null = null;

    const compact = computed(() => containerWidth.value > 0 && containerWidth.value < 720);

    /** 打码状态：供应商名与模型名替换成占位符，供截图分享 */
    const maskEnabled = ref(false);
    const maskMap = ref(new Map<string, string>());

    function maskText(value: string): string {
        if (!maskEnabled.value || !value) return value;
        const existing = maskMap.value.get(value);
        if (existing) return existing;
        const placeholder = t('settings.usage.mask.placeholder', {
            index: maskMap.value.size + 1,
        });
        maskMap.value.set(value, placeholder);
        return placeholder;
    }

    function toggleMask() {
        maskEnabled.value = !maskEnabled.value;
        if (!maskEnabled.value) {
            maskMap.value = new Map();
        }
    }

    /** 当前筛选条件；所有查询共用，保证口径一致 */
    const filter = computed<UsageFilter>(() => ({
        ...resolveUsageRange(preset.value),
        modelIds: modelIds.value.length ? modelIds.value : undefined,
        providerIds: providerIds.value.length ? providerIds.value : undefined,
        statuses: statuses.value?.length ? statuses.value : undefined,
        onlyFailed: statuses.value?.length === 1 && statuses.value[0] === 'failed',
        search: search.value.trim() || undefined,
    }));

    async function load() {
        loading.value = true;
        loadError.value = null;
        try {
            const current = filter.value;
            const [nextSummary, nextTrend, nextModels, nextProviders, nextOptions, nextCalls] =
                await Promise.all([
                    getUsageSummary(current),
                    getUsageTrend(current),
                    getUsageByModel(current),
                    getUsageByProvider(current),
                    getUsageFilterOptions(current),
                    getUsageCallPage(current, callOffset.value, PAGE_SIZE),
                ]);

            summary.value = nextSummary;
            trend.value = nextTrend;
            byModel.value = nextModels;
            byProvider.value = nextProviders;
            options.value = nextOptions;
            calls.value = nextCalls.rows;
            callTotal.value = nextCalls.total;
        } catch (error) {
            console.error('[SettingsUsageSection] Failed to load usage stats:', error);
            loadError.value = error instanceof Error ? error.message : String(error);
        } finally {
            loading.value = false;
        }
    }

    /** 热力图固定 53 周，只在首次加载与手动刷新时更新 */
    async function loadHeatmap() {
        try {
            heatmap.value = await getUsageHeatmap();
        } catch (error) {
            console.error('[SettingsUsageSection] Failed to load heatmap:', error);
        }
    }

    // 筛选变化重新查询（分页回到第一页）
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
        if (containerRef.value) {
            observer = new ResizeObserver((entries) => {
                containerWidth.value = entries[0]?.contentRect.width ?? 0;
            });
            observer.observe(containerRef.value);
        }
        void load();
        void loadHeatmap();
    });

    onBeforeUnmount(() => observer?.disconnect());

    const showHeatmap = computed(() => preset.value === 'all');
</script>

<template>
    <div ref="containerRef" class="settings-page-wide flex flex-col gap-4">
        <!-- 标题行 -->
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-col">
                <h2 class="font-serif text-lg text-neutral-900">{{ t('settings.usage.title') }}</h2>
                <span class="text-xs text-neutral-500">{{ t('settings.usage.subtitle') }}</span>
            </div>
            <div class="flex items-center gap-1.5">
                <button
                    type="button"
                    :class="[
                        'flex h-8 items-center gap-1.5 rounded-[8px] border px-2.5 text-[11px] transition-colors',
                        maskEnabled
                            ? 'border-neutral-800 bg-neutral-800 text-white'
                            : 'border-neutral-200/70 bg-white text-neutral-700 hover:border-neutral-300',
                    ]"
                    :aria-pressed="maskEnabled"
                    :title="t('settings.usage.mask.tip')"
                    @click="toggleMask"
                >
                    <AppIcon name="eye-off" class="h-3.5 w-3.5" />
                    {{ t('settings.usage.mask.label') }}
                </button>
                <button
                    type="button"
                    class="flex h-8 items-center gap-1.5 rounded-[8px] border border-neutral-200/70 bg-white px-2.5 text-[11px] text-neutral-700 transition-colors hover:border-neutral-300 disabled:opacity-50"
                    :disabled="loading"
                    @click="
                        () => {
                            void load();
                            void loadHeatmap();
                        }
                    "
                >
                    <AppIcon
                        name="refresh"
                        class="h-3.5 w-3.5"
                        :class="loading ? 'animate-spin' : ''"
                    />
                    {{ t('settings.usage.refresh') }}
                </button>
            </div>
        </div>

        <UsageFilters
            :filter="filter"
            :preset="preset"
            :options="options"
            :search="search"
            :compact="compact"
            :mask-text="maskText"
            @update:preset="preset = $event"
            @update:model-ids="modelIds = $event"
            @update:provider-ids="providerIds = $event"
            @update:statuses="statuses = $event"
            @update:search="search = $event"
        />

        <!-- 错误 -->
        <div
            v-if="loadError"
            class="rounded-[13px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
            {{ t('settings.usage.loadFailed') }}
        </div>

        <!-- 空状态 -->
        <div
            v-else-if="!loading && summary && summary.requestCount === 0"
            class="flex flex-col items-center gap-2 rounded-[13px] border border-neutral-200/70 bg-white py-16"
        >
            <AppIcon name="chart" class="h-12 w-12 text-neutral-300" />
            <p class="font-serif text-sm text-neutral-700">{{ t('settings.usage.empty.title') }}</p>
            <p class="text-xs text-neutral-500">{{ t('settings.usage.empty.body') }}</p>
        </div>

        <template v-else>
            <UsageHero v-if="summary" :summary="summary" :compact="compact" :mask-text="maskText" />

            <UsageHeatmap v-if="showHeatmap" :days="heatmap" :compact="compact" />
            <UsageTrendChart
                v-else
                :points="trend.points"
                :bucket="trend.bucket"
                :compact="compact"
            />

            <!-- Tab -->
            <div class="flex items-center gap-1 border-b border-neutral-200/70">
                <button
                    v-for="tab in TABS"
                    :key="tab.value"
                    type="button"
                    :class="[
                        '-mb-px border-b-2 px-3 py-1.5 text-xs transition-colors',
                        activeTab === tab.value
                            ? 'border-neutral-800 font-semibold text-neutral-900'
                            : 'border-transparent text-neutral-500 hover:text-neutral-800',
                    ]"
                    :aria-selected="activeTab === tab.value"
                    @click="activeTab = tab.value"
                >
                    {{ t(tab.labelKey) }}
                </button>
            </div>

            <div v-show="activeTab === 'overview'" class="flex flex-col gap-4">
                <UsageGroupList
                    :title="t('settings.usage.group.byModel')"
                    :groups="byModel"
                    :selected-id="modelIds[0] ?? null"
                    :mask-text="maskText"
                    @select="modelIds = $event === null ? [] : [$event]"
                />
                <UsageGroupList
                    :title="t('settings.usage.group.byProvider')"
                    :groups="byProvider"
                    :selected-id="providerIds[0] ?? null"
                    :mask-text="maskText"
                    @select="providerIds = $event === null ? [] : [$event]"
                />
            </div>

            <UsageCallTable
                v-show="activeTab === 'calls'"
                :rows="calls"
                :total="callTotal"
                :offset="callOffset"
                :limit="PAGE_SIZE"
                :compact="compact"
                :mask-text="maskText"
                @change-page="callOffset = $event"
            />

            <UsageGroupList
                v-show="activeTab === 'models'"
                :title="t('settings.usage.group.byModel')"
                :groups="byModel"
                :selected-id="modelIds[0] ?? null"
                :mask-text="maskText"
                @select="modelIds = $event === null ? [] : [$event]"
            />

            <UsageGroupList
                v-show="activeTab === 'providers'"
                :title="t('settings.usage.group.byProvider')"
                :groups="byProvider"
                :selected-id="providerIds[0] ?? null"
                :mask-text="maskText"
                @select="providerIds = $event === null ? [] : [$event]"
            />
        </template>
    </div>
</template>
