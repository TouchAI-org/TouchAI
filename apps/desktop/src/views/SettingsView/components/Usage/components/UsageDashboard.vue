<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { UsageSummary } from '@database/queries/usageStats';
    import {
        AppEvent,
        eventService,
        type SessionTaskUsageProgressEvent,
        type UsageThroughputSample,
    } from '@services/EventService';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { t } from '@/i18n';

    import {
        formatCost,
        formatDuration,
        formatInt,
        formatPercent,
        formatTokensCompact,
    } from '../utils/format';
    import { aggregateStreams, isStale, shouldDropFinishedStreams } from '../utils/liveAggregate';

    interface Props {
        /** 历史汇总；无数据时为 null */
        summary: UsageSummary | null;
    }

    const props = defineProps<Props>();

    defineOptions({ name: 'UsageDashboard' });

    /** 曲线采样节拍；比事件推送慢，避免高频重绘 */
    const SAMPLE_INTERVAL_MS = 500;
    const MAX_SAMPLES = 60;
    /** 全部结束后保留最终快照的时长 */
    const LINGER_MS = 60_000;

    /**
     * 每路流的最新状态，按 taskId 索引。
     *
     * 一个会话同时只有一个任务，但不同会话可以并行，所以必须用 Map：
     * 用单个对象会让两路流互相覆盖，面板在两份数字之间跳。
     */
    const streams = ref(new Map<string, SessionTaskUsageProgressEvent>());
    const lastSeenAt = new Map<string, number>();
    const samples = ref<UsageThroughputSample[]>([]);

    let unlisten: (() => void) | null = null;
    let sampleTimer: ReturnType<typeof setInterval> | null = null;
    let curveStartedAt = 0;

    const aggregate = computed(() => aggregateStreams([...streams.value.values()]));
    const anyStreaming = computed(() => aggregate.value.anyStreaming);
    const hasLiveStreams = computed(() => streams.value.size > 0);

    /**
     * 面板有两种语义，但只有一块：
     *
     * - 有流（正在对话或刚结束）：显示**这一轮**的实时数字
     * - 无流（打开页面时）：显示**所选区间**的历史汇总
     *
     * 合并而不是并排，是因为两者回答的是同一个问题（「用了多少」），
     * 并排会让用户同时看到两组互相矛盾的数字。
     */
    const mode = computed<'live' | 'history'>(() => (hasLiveStreams.value ? 'live' : 'history'));

    // ===== 指标卡 =====

    const lastSpeed = ref<number | null>(null);

    const speedText = computed(() => {
        const speed = aggregate.value.speed ?? lastSpeed.value;
        if (speed === null || !Number.isFinite(speed)) return '—';
        return speed.toFixed(1);
    });

    interface Card {
        key: string;
        label: string;
        value: string;
        prefix: string;
        note: string;
        warn: boolean;
    }

    /** 实时模式：这一轮的成本 / token / 首字 / 耗时 */
    const liveCards = computed<Card[]>(() => {
        const cost = aggregate.value.totalCostMicros;
        return [
            {
                key: 'cost',
                label: t('settings.usage.metric.cost'),
                value: cost === null ? '—' : formatCost(cost),
                prefix: cost === null ? '' : '≈ ',
                note: t('settings.usage.live.estimateNoteShort'),
                warn: false,
            },
            {
                key: 'tokens',
                label: t('settings.usage.metric.tokens'),
                value: formatTokensCompact(aggregate.value.totalTokens),
                prefix: '',
                note: t('settings.usage.live.estimatedTokens'),
                warn: false,
            },
            {
                key: 'ttft',
                label: t('settings.usage.metric.ttft'),
                value: formatDuration(aggregate.value.ttftMs),
                prefix: '',
                note: t('settings.usage.metric.ttftNote'),
                warn: false,
            },
            {
                key: 'elapsed',
                label: t('settings.usage.live.elapsed'),
                value: elapsedText.value,
                prefix: '',
                note: anyStreaming.value
                    ? t('settings.usage.live.streaming')
                    : t('settings.usage.live.stopped'),
                warn: false,
            },
        ];
    });

    /** 历史模式：所选区间的汇总 */
    const historyCards = computed<Card[]>(() => {
        const summary = props.summary;
        if (!summary) return [];

        return [
            {
                key: 'cost',
                label: t('settings.usage.metric.cost'),
                value: formatCost(summary.totalCostMicros),
                // 有未定价调用时加 ≥ 前缀，绝不把未知当 0
                prefix: summary.unpricedCount > 0 ? '≥ ' : '',
                note:
                    summary.unpricedCount > 0
                        ? t('settings.usage.metric.unpriced', { count: summary.unpricedCount })
                        : t('settings.usage.metric.costNote'),
                warn: summary.unpricedCount > 0,
            },
            {
                key: 'requests',
                label: t('settings.usage.metric.requests'),
                value: formatInt(summary.requestCount),
                prefix: '',
                note: t('settings.usage.metric.requestsNote', {
                    rate: formatPercent(summary.successRate),
                }),
                warn: false,
            },
            {
                key: 'sessions',
                label: t('settings.usage.metric.sessions'),
                value: formatInt(summary.sessionCount),
                prefix: '',
                note: t('settings.usage.metric.sessionsNote'),
                warn: false,
            },
            {
                key: 'tokens',
                label: t('settings.usage.metric.tokens'),
                value: formatTokensCompact(summary.realTotalTokens),
                prefix: '',
                note: t('settings.usage.metric.tokensNote'),
                warn: false,
            },
            {
                key: 'ttft',
                label: t('settings.usage.metric.ttft'),
                value: formatDuration(summary.meanTtftMs),
                prefix: '',
                note: t('settings.usage.metric.ttftNote'),
                warn: false,
            },
        ];
    });

    const cards = computed(() => (mode.value === 'live' ? liveCards.value : historyCards.value));

    /** 次级指标：历史模式才展示口径拆分 */
    const secondaryMetrics = computed(() => {
        const summary = props.summary;
        if (mode.value === 'live' || !summary) return [];

        const items = [
            {
                key: 'input',
                label: t('settings.usage.metric.freshInput'),
                value: formatTokensCompact(summary.inputTokens),
            },
            {
                key: 'output',
                label: t('settings.usage.metric.output'),
                value: formatTokensCompact(summary.outputTokens),
            },
            {
                key: 'cacheRead',
                label: t('settings.usage.metric.cacheRead'),
                value: formatTokensCompact(summary.cacheReadTokens),
            },
            {
                key: 'cacheRate',
                label: t('settings.usage.metric.cacheHitRate'),
                value: formatPercent(summary.cacheHitRate),
            },
        ];

        // 推理 token 只在真的有值时出现：恒为 0 是噪音
        if (summary.reasoningTokens > 0) {
            items.splice(2, 0, {
                key: 'reasoning',
                label: t('settings.usage.metric.reasoning'),
                value: formatTokensCompact(summary.reasoningTokens),
            });
        }

        return items;
    });

    const elapsedText = computed(() => {
        const ms = aggregate.value.elapsedMs;
        const totalSeconds = Math.floor(ms / 1000);
        return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
    });

    const modelLabels = computed(() => aggregate.value.modelNames.slice(0, 3));
    const hiddenModelCount = computed(() =>
        Math.max(0, aggregate.value.modelNames.length - modelLabels.value.length)
    );

    // ===== 曲线几何 =====

    const VIEW_WIDTH = 520;
    const VIEW_HEIGHT = 96;
    const PADDING = { top: 8, right: 4, bottom: 4, left: 4 };
    const innerWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
    const innerHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;

    const geometry = computed(() => {
        const items = samples.value;
        if (items.length === 0) return [];

        const peak = Math.max(1, ...items.map((item) => item.tokensPerSecond));
        const step = items.length > 1 ? innerWidth / (items.length - 1) : 0;

        return items.map((item, index) => ({
            x: PADDING.left + (items.length > 1 ? index * step : innerWidth / 2),
            y: PADDING.top + innerHeight - (item.tokensPerSecond / peak) * innerHeight,
        }));
    });

    const linePath = computed(() =>
        geometry.value
            .map(
                (point, index) =>
                    `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`
            )
            .join(' ')
    );

    const areaPath = computed(() => {
        const points = geometry.value;
        if (points.length === 0) return '';
        const baseline = PADDING.top + innerHeight;
        const first = points[0]!;
        const last = points[points.length - 1]!;
        return `${linePath.value} L${last.x.toFixed(1)},${baseline} L${first.x.toFixed(1)},${baseline} Z`;
    });

    // ===== 采样与清理 =====

    function pushAggregateSample() {
        const speed = aggregate.value.speed;
        if (speed === null || !Number.isFinite(speed) || speed <= 0) return;

        if (curveStartedAt === 0) curveStartedAt = Date.now();
        lastSpeed.value = speed;
        samples.value = [
            ...samples.value,
            { atMs: Date.now() - curveStartedAt, tokensPerSecond: speed },
        ].slice(-MAX_SAMPLES);
    }

    function resetCurve() {
        samples.value = [];
        curveStartedAt = 0;
        lastSpeed.value = null;
    }

    function prune() {
        const now = Date.now();
        let changed = false;

        for (const [taskId, stream] of streams.value) {
            const seenAt = lastSeenAt.get(taskId) ?? 0;
            if (!isStale(stream, seenAt, now, LINGER_MS)) continue;
            streams.value.delete(taskId);
            lastSeenAt.delete(taskId);
            changed = true;
        }

        if (changed) {
            streams.value = new Map(streams.value);
        }
    }

    onMounted(() => {
        sampleTimer = setInterval(() => {
            pushAggregateSample();
            prune();
        }, SAMPLE_INTERVAL_MS);

        void eventService
            .on(AppEvent.SESSION_TASK_USAGE_PROGRESS, (payload) => {
                const isNewStream = !streams.value.has(payload.taskId);

                // 新一轮开始时清掉已结束的旧流，免得上一轮的 token 累加到这一轮
                if (shouldDropFinishedStreams([...streams.value.values()], isNewStream)) {
                    streams.value.clear();
                    lastSeenAt.clear();
                    resetCurve();
                }

                streams.value.set(payload.taskId, payload);
                lastSeenAt.set(payload.taskId, Date.now());
                streams.value = new Map(streams.value);
            })
            .then((stop) => {
                unlisten = stop;
            });
    });

    onUnmounted(() => {
        if (sampleTimer) clearInterval(sampleTimer);
        sampleTimer = null;
        unlisten?.();
        unlisten = null;
    });
</script>

<template>
    <section class="settings-row-group p-4" data-testid="settings-usage-dashboard">
        <!-- 头部：标题随语义切换；速度只在实时模式下有意义 -->
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 text-[13px] text-neutral-950">
                    {{
                        mode === 'live'
                            ? t('settings.usage.live.title')
                            : t('settings.usage.dashboardHistoryTitle')
                    }}
                </span>
                <span
                    v-for="label in modelLabels"
                    :key="label"
                    class="max-w-44 truncate rounded-full bg-neutral-100 px-2.5 py-0.5 text-[11px] text-neutral-600"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ label }}
                </span>
                <span v-if="hiddenModelCount > 0" class="shrink-0 text-[11px] text-neutral-400">
                    +{{ hiddenModelCount }}
                </span>
            </div>

            <div v-if="mode === 'live'" class="flex items-baseline gap-1.5">
                <span
                    class="font-serif text-[26px] leading-none font-semibold tabular-nums"
                    :class="anyStreaming ? 'text-neutral-950' : 'text-neutral-300'"
                >
                    {{ speedText }}
                </span>
                <span class="text-[11px] text-neutral-400">tok/s</span>
            </div>
        </div>

        <!-- 指标卡：历史态 5 张，实时态 4 张，分别给列数避免最后一张落单 -->
        <div
            :class="[
                'mt-3 grid grid-cols-2 gap-3',
                mode === 'history' ? 'sm:grid-cols-3 lg:grid-cols-5' : 'lg:grid-cols-4',
            ]"
        >
            <div
                v-for="card in cards"
                :key="card.key"
                class="flex min-w-0 flex-col gap-1 rounded-[10px] bg-neutral-50/80 px-4 py-3"
            >
                <span class="truncate text-xs text-neutral-500">{{ card.label }}</span>
                <span
                    class="truncate font-serif text-[22px] leading-tight font-semibold text-neutral-950 tabular-nums"
                    :title="`${card.prefix}${card.value}`"
                >
                    {{ card.prefix }}{{ card.value }}
                </span>
                <span
                    class="truncate text-[11px]"
                    :class="card.warn ? 'text-amber-600' : 'text-neutral-400'"
                >
                    {{ card.note }}
                </span>
            </div>
        </div>

        <div
            v-if="secondaryMetrics.length > 0"
            class="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 border-t border-neutral-100 pt-3"
        >
            <div
                v-for="item in secondaryMetrics"
                :key="item.key"
                class="flex items-baseline gap-2 text-xs"
            >
                <span class="text-neutral-500">{{ item.label }}</span>
                <span class="text-neutral-800 tabular-nums" :title="item.value">
                    {{ item.value }}
                </span>
            </div>
        </div>

        <!-- 吞吐曲线：只在有流时出现，历史模式不占地方 -->
        <div v-if="mode === 'live'" class="mt-3 rounded-[11px] bg-neutral-50/80 p-3">
            <div class="flex items-center justify-between">
                <span class="text-[10px] tracking-wide text-neutral-400 uppercase">
                    {{ t('settings.usage.live.throughput') }}
                </span>
                <span
                    class="flex items-center gap-1.5 text-[11px]"
                    :class="anyStreaming ? 'text-neutral-700' : 'text-neutral-400'"
                >
                    <span
                        class="h-1.5 w-1.5 rounded-full"
                        :class="anyStreaming ? 'animate-pulse bg-sky-500' : 'bg-neutral-300'"
                        aria-hidden="true"
                    />
                    {{
                        anyStreaming
                            ? t('settings.usage.live.online')
                            : t('settings.usage.live.idle')
                    }}
                </span>
            </div>

            <div v-if="geometry.length === 0" class="flex h-[96px] items-center justify-center">
                <span class="text-[11px] text-neutral-400">
                    {{ t('settings.usage.live.waiting') }}
                </span>
            </div>

            <svg
                v-else
                :viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`"
                :height="VIEW_HEIGHT"
                class="mt-1 w-full"
                role="img"
                :aria-label="t('settings.usage.live.throughput')"
            >
                <path :d="areaPath" fill="currentColor" class="text-sky-500/10" />
                <path
                    :d="linePath"
                    fill="none"
                    stroke="currentColor"
                    class="text-sky-500"
                    stroke-width="1.6"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                />
                <circle
                    :cx="geometry[geometry.length - 1]!.x"
                    :cy="geometry[geometry.length - 1]!.y"
                    r="2.5"
                    fill="currentColor"
                    class="text-sky-500"
                />
            </svg>

            <div
                class="mt-2 flex items-center justify-between border-t border-dashed border-neutral-200 pt-2"
            >
                <span class="text-[10px] tracking-wide text-neutral-400 uppercase">
                    {{ t('settings.usage.live.stream') }}
                </span>
                <span class="text-[11px] text-neutral-500 tabular-nums">
                    {{ t('settings.usage.live.activeStreams', { count: aggregate.activeCount }) }}
                </span>
            </div>
        </div>

        <p class="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11px] text-neutral-400">
            <AppIcon name="information-circle" class="h-3 w-3 shrink-0" />
            {{
                mode === 'live'
                    ? t('settings.usage.live.estimateNote')
                    : t('settings.usage.dashboardHistoryNote')
            }}
        </p>
    </section>
</template>
