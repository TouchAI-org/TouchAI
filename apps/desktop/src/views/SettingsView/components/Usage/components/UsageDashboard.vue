<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { UsageSummary, UsageTrendPoint } from '@database/queries/usageStats';
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
        /** 所选区间的趋势序列，用于无实时数据时填充图表 */
        trend: UsageTrendPoint[];
        /** 当前筛选的区间，用于计算平均 RPM */
        range: { preset: string; from: string; to: string };
        /** 区间内真实的首末时间跨度；「全部时间」靠它算 RPM */
        actualSpanMs: number;
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

    // 不再有“实时模式 / 历史模式”的切换：历史是基线，实时往上累加，
    // 面板只有一套语义，数字与曲线都是连续变化的。

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

    /**
     * 统一指标卡：历史汇总是基线，实时流是叠加量。
     *
     * 有流时直接在区间汇总上累加这一轮，而不是切换成另一组数字：
     * 面板不会因为一次对话就“换一套口径”，数字是连续往上长的。
     */
    const cards = computed<Card[]>(() => {
        const summary = props.summary;
        const live = aggregate.value;
        const streaming = anyStreaming.value;

        // 无历史数据时也给出可读的零值，而不是空白
        const baseTokens = summary?.realTotalTokens ?? 0;
        const baseRequests = summary?.requestCount ?? 0;
        const baseCost = summary?.totalCostMicros ?? 0;
        const baseSessions = summary?.sessionCount ?? 0;

        const liveTokens = live.totalTokens;
        const liveRequests = streaming || hasLiveStreams.value ? live.activeCount + 1 : 0;
        const liveCost = live.totalCostMicros;

        const items: Card[] = [
            {
                key: 'cost',
                label: t('settings.usage.metric.cost'),
                value: formatCost(baseCost + (liveCost ?? 0)),
                // 只有“确实有未定价调用”时才加 ≥；有流且本轮未定价也算
                prefix:
                    (summary?.unpricedCount ?? 0) > 0 || (hasLiveStreams.value && liveCost === null)
                        ? '≥ '
                        : '',
                note:
                    liveCost !== null && hasLiveStreams.value
                        ? t('settings.usage.metric.costNoteWithLive')
                        : summary && summary.unpricedCount > 0
                          ? t('settings.usage.metric.unpriced', { count: summary.unpricedCount })
                          : t('settings.usage.metric.costNote'),
                warn: (summary?.unpricedCount ?? 0) > 0,
            },
            {
                key: 'requests',
                label: t('settings.usage.metric.requests'),
                value: formatInt(baseRequests + liveRequests),
                prefix: '',
                note: summary
                    ? t('settings.usage.metric.requestsNote', {
                          rate: formatPercent(summary.successRate),
                      })
                    : t('settings.usage.metric.requestsNote', { rate: '—' }),
                warn: false,
            },
            {
                key: 'sessions',
                label: t('settings.usage.metric.sessions'),
                value: formatInt(baseSessions + (hasLiveStreams.value ? 1 : 0)),
                prefix: '',
                note: t('settings.usage.metric.sessionsNote'),
                warn: false,
            },
            {
                key: 'tokens',
                label: t('settings.usage.metric.tokens'),
                value: formatTokensCompact(baseTokens + liveTokens),
                prefix: '',
                note: hasLiveStreams.value
                    ? t('settings.usage.metric.tokensNoteWithLive')
                    : t('settings.usage.metric.tokensNote'),
                warn: false,
            },
        ];

        // 有流时第四张换成「已用时」，把握手阶段的实际情况说清楚
        if (hasLiveStreams.value) {
            items.push({
                key: 'elapsed',
                label: t('settings.usage.live.elapsed'),
                value: elapsedText.value,
                prefix: '',
                note: streaming
                    ? t('settings.usage.live.streaming')
                    : t('settings.usage.live.stopped'),
                warn: false,
            });
        } else {
            items.push({
                key: 'ttft',
                label: t('settings.usage.metric.ttft'),
                value: formatDuration(summary?.meanTtftMs ?? null),
                prefix: '',
                note: t('settings.usage.metric.ttftNote'),
                warn: false,
            });
        }

        return items;
    });

    /**
     * 次级指标：做成一排小卡片，而不是一行薄文本。
     *
     * 平均 RPM 由所选区间的请求数除以实际跨度算出：
     * 要求的是“平均每分钟多少请求”，分母应该是区间长度（小时级以下用分钟）
     * 而不是固定的 30 天——选“今天”时分子小但分母也小，两者才能对齐。
     */
    const secondaryMetrics = computed(() => {
        const summary = props.summary;
        if (!summary) return [];

        const items: Array<{ key: string; label: string; value: string; note?: string }> = [
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
            {
                key: 'rpm',
                label: t('settings.usage.metric.rpm'),
                value: averageRpm.value === null ? '—' : averageRpm.value.toFixed(2),
                note: t('settings.usage.metric.rpmNote'),
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

    /** 平均 RPM：区间内每分钟请求数 */
    const averageRpm = computed<number | null>(() => {
        const summary = props.summary;
        if (!summary || summary.requestCount === 0) return null;

        const from = Date.parse(props.range.from.replace(' ', 'T') + 'Z');
        const to = Date.parse(props.range.to.replace(' ', 'T') + 'Z');
        const spanMs = to - from;
        // 「全部时间」的跨度被钳到 1970-9999，没有意义，改用真实首末时间
        const effective = props.range.preset === 'all' ? props.actualSpanMs : spanMs;
        if (!Number.isFinite(effective) || effective <= 0) return null;

        const minutes = effective / 60_000;
        if (minutes < 1) return null;
        return summary.requestCount / minutes;
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

    // ===== 曲线数据：历史与实时接在同一条时间轴上 =====
    //
    // 两者单位不同（历史是 token 数，实时是 tok/s），直接混在一起会误导。
    // 这里统一成「累计 token」：历史用桶内 token，实时用本轮累计 token，
    // 一条曲线从过去一直画到现在，新对话只是把尾部接上，不换图。

    interface CurvePoint {
        label: string;
        value: number;
        /** true 表示该点来自实时流（用于区分后半段） */
        live: boolean;
    }

    /** 历史趋势：按时间桶的 token 总量 */
    const historyCurve = computed<CurvePoint[]>(() =>
        props.trend.map((point) => ({ label: point.key, value: point.tokens, live: false }))
    );

    /**
     * 实时段：本轮每采样周期的**新增** token。
     *
     * 与历史桶同量级才能拼成一条线：并存时直接累加在当前尾部。
     */
    const liveCurve = computed<CurvePoint[]>(() => {
        const points: CurvePoint[] = [];
        let previous = 0;

        for (const sample of samples.value) {
            const total = sample.totalTokens;
            points.push({
                label: String(Math.round(sample.atMs / 1000)),
                value: Math.max(0, total - previous),
                live: true,
            });
            previous = total;
        }

        return points;
    });

    /** 实时段存在时接在历史后面；两者共享同一套坐标 */
    const curvePoints = computed<CurvePoint[]>(() => {
        const history = historyCurve.value;
        const live = liveCurve.value;
        if (live.length === 0) return history;
        if (history.length === 0) return live;

        // 只保留最近一段历史，避免实时尾部被压成一条线
        const tail = history.slice(-Math.max(6, Math.floor(MAX_SAMPLES * 0.4)));
        return [...tail, ...live];
    });

    const curveUnit = computed(() => t('settings.usage.metric.tokens'));

    /** 分界点：历史段结束的位置，用于在图上画一条竖线 */
    const liveBoundaryIndex = computed(() => {
        if (liveCurve.value.length === 0) return -1;
        return curvePoints.value.length - liveCurve.value.length;
    });

    const VIEW_WIDTH = 520;
    const VIEW_HEIGHT = 96;
    const PADDING = { top: 8, right: 4, bottom: 4, left: 4 };
    const innerWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
    const innerHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;

    const geometry = computed(() => {
        const items = curvePoints.value;
        if (items.length === 0) return [];

        const peak = Math.max(1, ...items.map((item) => item.value));
        const step = items.length > 1 ? innerWidth / (items.length - 1) : 0;

        return items.map((item, index) => ({
            ...item,
            x: PADDING.left + (items.length > 1 ? index * step : innerWidth / 2),
            y: PADDING.top + innerHeight - (item.value / peak) * innerHeight,
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

    /**
     * 追加一个采样点。
     *
     * 采样同时记速度与**累计 token**：曲线用累计增量接在历史后面，
     * 而速度只用于右上角那个大号数字。
     */
    function pushAggregateSample() {
        const speed = aggregate.value.speed;
        const totalTokens = aggregate.value.totalTokens;
        if (totalTokens <= 0) return;

        if (curveStartedAt === 0) curveStartedAt = Date.now();
        if (speed !== null && Number.isFinite(speed) && speed > 0) {
            lastSpeed.value = speed;
        }

        samples.value = [
            ...samples.value,
            {
                atMs: Date.now() - curveStartedAt,
                tokensPerSecond: speed ?? 0,
                totalTokens,
            },
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
    <section class="pb-1" data-testid="settings-usage-dashboard">
        <!-- 头部：标题固定，不再因为有无流而换标题 -->
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 text-[13px] text-neutral-950">
                    {{ t('settings.usage.dashboardHistoryTitle') }}
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

            <div v-if="hasLiveStreams" class="flex items-baseline gap-1.5">
                <span
                    class="font-serif text-[26px] leading-none font-semibold tabular-nums"
                    :class="anyStreaming ? 'text-neutral-950' : 'text-neutral-300'"
                >
                    {{ speedText }}
                </span>
                <span class="text-[11px] text-neutral-400">tok/s</span>
            </div>
        </div>

        <!-- 主指标卡 -->
        <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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

        <!-- 次级指标也做成卡片，与主指标同一套视觉 -->
        <div
            v-if="secondaryMetrics.length > 0"
            class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
        >
            <div
                v-for="item in secondaryMetrics"
                :key="item.key"
                class="flex min-w-0 flex-col gap-0.5 rounded-[9px] bg-neutral-50/60 px-3 py-2"
            >
                <span class="truncate text-[11px] text-neutral-500">{{ item.label }}</span>
                <span
                    class="truncate text-[13px] text-neutral-900 tabular-nums"
                    :title="item.value"
                >
                    {{ item.value }}
                </span>
            </div>
        </div>

        <!-- 曲线常驻：历史与实时接在同一条线上，有流时尾部继续往前画 -->
        <div class="mt-3 rounded-[11px] bg-neutral-50/80 p-3">
            <div class="flex items-center justify-between">
                <span class="text-[10px] tracking-wide text-neutral-400 uppercase">
                    {{ t('settings.usage.dashboardCurveTitle') }} · {{ curveUnit }}
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
                :aria-label="t('settings.usage.dashboardCurveTitle')"
            >
                <!-- 历史段与实时段的分界；有流才画 -->
                <line
                    v-if="liveBoundaryIndex > 0 && geometry[liveBoundaryIndex]"
                    :x1="geometry[liveBoundaryIndex]!.x"
                    :x2="geometry[liveBoundaryIndex]!.x"
                    :y1="PADDING.top"
                    :y2="PADDING.top + innerHeight"
                    stroke="currentColor"
                    class="text-neutral-300"
                    stroke-width="1"
                    stroke-dasharray="2 2"
                />

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
        </div>

        <p class="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11px] text-neutral-400">
            <AppIcon name="information-circle" class="h-3 w-3 shrink-0" />
            {{
                hasLiveStreams
                    ? t('settings.usage.live.estimateNote')
                    : t('settings.usage.dashboardHistoryNote')
            }}
        </p>
    </section>
</template>
