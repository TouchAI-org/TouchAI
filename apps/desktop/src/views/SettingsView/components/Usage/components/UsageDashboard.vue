<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AnimatedCounter from '@components/ui/animated-counter/AnimatedCounter.vue';
    import LineChart from '@components/ui/line-chart/LineChart.vue';
    import RealtimeStream from '@components/ui/realtime-stream/RealtimeStream.vue';
    import type {
        UsageBucket,
        UsageLiveTurn,
        UsageSummary,
        UsageTrendPoint,
    } from '@database/queries/usageStats';
    import {
        AppEvent,
        eventService,
        type SessionTaskUsageProgressEvent,
    } from '@services/EventService';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import { getLocale, t } from '@/i18n';

    import {
        costCounter,
        type CounterSpec,
        formatActiveDuration,
        formatCost,
        formatDuration,
        formatInt,
        formatPercent,
        formatTokensCompact,
        intCounter,
        tokensCounter,
    } from '../utils/format';
    import { aggregateStreams } from '../utils/liveAggregate';
    import {
        buildLiveCurve,
        buildUsageCurve,
        LIVE_WINDOW_MS,
        mergeLiveUsage,
    } from '../utils/usageOverlay';

    interface Props {
        summary: UsageSummary | null;
        trend: UsageTrendPoint[];
        bucket: UsageBucket;
        liveTurns: UsageLiveTurn[];
        range: { preset: string; from: string; to: string };
    }
    const props = defineProps<Props>();
    const emit = defineEmits<{ 'track-tasks': [taskIds: string[]] }>();
    defineOptions({ name: 'UsageDashboard' });

    const streams = ref(new Map<string, SessionTaskUsageProgressEvent>());
    const seenAt = new Map<string, number>();
    const now = ref(Date.now());
    /**
     * 实时采样：本轮累计输出增量。
     *
     * 不存速度：速度是瞬时量，直接拿来画线会得到一条与总量无关的曲线。
     */
    const liveSamples = ref<Array<{ atMs: number; tokens: number; speed: number }>>([]);
    let timer: ReturnType<typeof setInterval> | null = null;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    const liveStates = computed(() =>
        [...streams.value.values()].map((stream) => ({
            ...stream,
            elapsedMs:
                stream.elapsedMs +
                (stream.streaming
                    ? Math.max(0, now.value - (seenAt.get(stream.taskId) ?? now.value))
                    : 0),
        }))
    );
    const aggregate = computed(() => {
        const pending = new Set(
            props.liveTurns
                .filter((turn) => turn.status === 'streaming' || turn.status === 'pending')
                .map((turn) => turn.taskId)
        );
        return aggregateStreams(liveStates.value.filter((stream) => pending.has(stream.taskId)));
    });
    const anyStreaming = computed(() => aggregate.value.anyStreaming);
    const summary = computed(() =>
        props.summary ? mergeLiveUsage(props.summary, props.liveTurns, liveStates.value) : null
    );
    const activityParts = computed(() => formatActiveDuration(summary.value?.totalDurationMs ?? 0));

    interface Card {
        key: string;
        label: string;
        value: string;
        prefix?: string;
        note: string;
        warn?: boolean;
        valueParts?: Array<{ value: string; unit: string }>;
        /** 交给数字滚轮：有值就滚动，否则直接显示 `value` */
        counter?: CounterSpec;
        description?: string;
    }
    const cards = computed<Card[]>(() => {
        const value = summary.value;
        return [
            {
                key: 'cost',
                label: t('settings.usage.metric.cost'),
                value: formatCost(value?.totalCostMicros ?? 0),
                counter: costCounter(value?.totalCostMicros ?? 0),
                prefix: (value?.unpricedCount ?? 0) > 0 ? '≥ ' : '',
                note:
                    (value?.unpricedCount ?? 0) > 0
                        ? t('settings.usage.metric.unpriced', { count: value!.unpricedCount })
                        : t('settings.usage.metric.costNote'),
                warn: (value?.unpricedCount ?? 0) > 0,
            },
            {
                key: 'requests',
                label: t('settings.usage.metric.requests'),
                value: formatInt(value?.requestCount ?? 0),
                counter: intCounter(value?.requestCount ?? 0),
                note: t('settings.usage.metric.requestsNote', {
                    rate: formatPercent(value?.successRate ?? 0),
                }),
            },
            {
                key: 'sessions',
                label: t('settings.usage.metric.sessions'),
                value: formatInt(value?.sessionCount ?? 0),
                counter: intCounter(value?.sessionCount ?? 0),
                note: t('settings.usage.metric.sessionsNote'),
            },
            {
                key: 'tokens',
                label: t('settings.usage.metric.tokens'),
                value: formatTokensCompact(value?.realTotalTokens ?? 0),
                counter: tokensCounter(value?.realTotalTokens ?? 0),
                note: t(
                    anyStreaming.value
                        ? 'settings.usage.metric.tokensNoteWithLive'
                        : 'settings.usage.metric.tokensNote'
                ),
            },
            {
                key: 'cacheRead',
                label: t('settings.usage.metric.cacheRead'),
                value: formatTokensCompact(value?.cacheReadTokens ?? 0),
                counter: tokensCounter(value?.cacheReadTokens ?? 0),
                note: t('settings.usage.metric.cacheReadNote', {
                    rate: formatPercent(value?.cacheHitRate ?? 0),
                }),
            },
            {
                key: 'activity',
                label: t('settings.usage.metric.activeDuration'),
                value: activityParts.value.map((part) => `${part.value} ${part.unit}`).join(' '),
                valueParts: activityParts.value,
                note: t(
                    value?.activeDayCount === 1
                        ? 'settings.usage.metric.activeDay'
                        : 'settings.usage.metric.activeDays',
                    { count: formatInt(value?.activeDayCount ?? 0) }
                ),
                description: t('settings.usage.metric.activeDurationNote'),
            },
        ];
    });

    /**
     * 平均 RPM：活跃分钟内的请求数。
     *
     * 不用日历跨度作分母：个人助理一个月才两百多次请求，除以 30 天永远是 0.00，
     * 这个数字不传递任何信息。分母换成回合耗时之和，回答的是
     * 「真正在对话的时候每分钟发几次」，与上面的活跃时长同一套口径。
     */
    const averageRpm = computed(() => {
        const value = summary.value;
        const activeMinutes = (value?.totalDurationMs ?? 0) / 60_000;
        if (!value?.requestCount || activeMinutes <= 0) return '—';
        const rpm = value.requestCount / activeMinutes;
        return rpm >= 10 ? rpm.toFixed(1) : rpm.toFixed(2);
    });

    const secondaryMetrics = computed(() => {
        const value = summary.value;
        if (!value) return [];
        const items = [
            {
                key: 'input',
                label: t('settings.usage.metric.freshInput'),
                value: formatTokensCompact(value.inputTokens),
            },
            {
                key: 'output',
                label: t('settings.usage.metric.output'),
                value: formatTokensCompact(value.outputTokens),
            },
            {
                key: 'cacheWrite',
                label: t('settings.usage.metric.cacheWrite'),
                value: formatTokensCompact(value.cacheWriteTokens),
            },
            {
                key: 'ttft',
                label: t('settings.usage.metric.ttft'),
                value: formatDuration(value.meanTtftMs),
                note: t('settings.usage.metric.ttftNote'),
            },
            {
                key: 'ttftP90',
                label: t('settings.usage.metric.firstText'),
                value: formatDuration(value.meanFirstTextMs ?? null),
                note: t('settings.usage.metric.firstTextNote'),
            },
            { key: 'rpm', label: t('settings.usage.metric.rpm'), value: averageRpm.value },
        ];
        if (value.reasoningTokens > 0)
            items.splice(2, 0, {
                key: 'reasoning',
                label: t('settings.usage.metric.reasoning'),
                value: formatTokensCompact(value.reasoningTokens),
            });
        return items;
    });

    /**
     * 有流时用滑动窗口，无流时用区间汇总。
     *
     * 两者不能共用一条横轴：区间可能是 24 小时，而一轮对话只有几十秒，
     * 放在同一个时间尺度上永远是平的。切换时标题会同步变化，不让读者误解。
     */
    const liveMode = computed(() => liveSamples.value.length > 0);

    /**
     * 窗口长度做一次“逐步收窄”的动画。
     *
     * 从大尺度直接跳到 1 分钟会让图形瞬间变形，看不出发生了什么。
     * 这里用几个中间尺度做缓动：120s → 60s，视觉上就像镜头拉近，
     * 旧的历史被挤出左侧，当前的增量被放大。
     */
    const ZOOM_STEPS = [300, 180, 120, 90, 60] as const;
    const zoomWindowMs = ref<number>(LIVE_WINDOW_MS);
    /** 缩放动画的定时器；卸载时要清掉，否则会往已销毁的组件写值 */
    const timers = new Set<ReturnType<typeof setInterval>>();

    watch(liveMode, (active) => {
        if (!active) {
            zoomWindowMs.value = LIVE_WINDOW_MS;
            return;
        }
        // 进入实时模式：从大窗口逐级收到 1 分钟
        let index = 0;
        zoomWindowMs.value = ZOOM_STEPS[0]!;
        const timer = setInterval(() => {
            index += 1;
            if (index >= ZOOM_STEPS.length) {
                zoomWindowMs.value = LIVE_WINDOW_MS;
                clearInterval(timer);
                return;
            }
            zoomWindowMs.value = ZOOM_STEPS[index]!;
        }, 120);
        timers.add(timer);
    });

    const curve = computed(() =>
        liveMode.value
            ? buildLiveCurve(liveSamples.value, zoomWindowMs.value * 1000, now.value)
            : buildUsageCurve(
                  props.trend,
                  props.bucket,
                  props.range,
                  props.liveTurns,
                  liveStates.value
              )
    );
    /** 实时采样点：直接交给 RealtimeStream，值用采集器自己的速度 */
    const livePoints = computed(() =>
        liveSamples.value.map((sample) => ({ at: sample.atMs, value: sample.speed ?? 0 }))
    );

    /**
     * 曲线数据交给 LineChart。
     *
     * x 用真实时间，所以实时窗口收窄时曲线会被横向拉伸，
     * 而不是把旧点挤在左边。
     */
    const curveData = computed(() => {
        const points = curve.value;
        if (points.length === 0) return [];
        const first = points[0]!.at;
        const span = points[points.length - 1]!.at - first || 1;
        return points.map((point) => ({
            key: String(point.at),
            label: formatClock(point.at),
            // LineChart 的 x 是均匀下标，这里用归一化后的时间轴保真
            values: { value: point.value },
            ratio: (point.at - first) / span,
        }));
    });

    /** 时间标签：HH:mm:ss，用于 tooltip */
    function formatClock(at: number): string {
        const date = new Date(at);
        return [date.getHours(), date.getMinutes(), date.getSeconds()]
            .map((value) => String(value).padStart(2, '0'))
            .join(':');
    }

    /** 纵轴单位：实时模式是 token/秒，历史模式是 token 总量 */
    const curveUnit = computed(() =>
        liveMode.value ? 'tok/s' : t('settings.usage.metric.tokens')
    );

    /** 格式化纵轴与尾端数值：实时模式是速率，保留一位小数 */
    function formatCurveValue(value: number): string {
        if (!liveMode.value) return formatTokensCompact(value);
        return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
    }

    /**
     * 吞吐显示：有流时用实时速度，空闲时用区间平均速度。
     *
     * 空闲时如果什么都不显示，右上角就空着，读者也不知道这一整段时间快不快；
     * `decodeSpeed` 是「输出 token / 平均耗时」，正好回答这个问题。
     */
    const speedDisplay = computed(() => {
        const value = anyStreaming.value
            ? aggregate.value.speed
            : (summary.value?.decodeSpeed ?? null);
        if (value === null || !Number.isFinite(value) || value <= 0) return '—';
        return value.toFixed(1);
    });

    onMounted(() => {
        timer = setInterval(() => {
            now.value = Date.now();

            /*
             * 直接采样速度，而不是对累计 token 做差分。
             *
             * 差分有两个致命问题：
             * 1. 采集器每 300ms 才推一次，500ms 节拍经常采到同一个值 → 速率为 0；
             * 2. 结束时事件会把估算值改成实测值，差分算出一次巨额跳变。
             * 采集器本身已经有滑动窗口算出的瞬时速度，直接用它最准，
             * 也与右上角那个数字完全一致。
             */
            const speed = aggregate.value.speed;
            const total = aggregate.value.totalTokens;
            if (total > 0) {
                const previous = liveSamples.value[liveSamples.value.length - 1];
                // 只在数值真的变了时追加，避免把同一秒重复画成平线
                if (!previous || total !== previous.tokens) {
                    liveSamples.value = [
                        ...liveSamples.value,
                        { atMs: now.value, tokens: total, speed: speed ?? 0 },
                    ].slice(-600);
                }
            }

            // 已结束且已由汇总接管的快照才可清理。未落库的最终事件保留到刷新完成。
            let changed = false;
            for (const [taskId, stream] of streams.value) {
                const turn = props.liveTurns.find((item) => item.taskId === taskId);
                const terminal = turn && turn.status !== 'pending' && turn.status !== 'streaming';
                if (
                    (!stream.streaming || terminal) &&
                    now.value - (seenAt.get(taskId) ?? 0) >= 60_000
                ) {
                    streams.value.delete(taskId);
                    seenAt.delete(taskId);
                    changed = true;
                }
            }
            if (changed) {
                streams.value = new Map(streams.value);
                emit('track-tasks', [...streams.value.keys()]);
            }
        }, 500);
        void eventService
            .on(AppEvent.SESSION_TASK_USAGE_PROGRESS, (payload) => {
                const isNew = !streams.value.has(payload.taskId);
                streams.value.set(payload.taskId, payload);
                seenAt.set(payload.taskId, Date.now());
                now.value = Date.now();
                streams.value = new Map(streams.value);
                if (isNew) liveSamples.value = [];
                if (isNew || !payload.streaming) emit('track-tasks', [...streams.value.keys()]);
            })
            .then((stop) => {
                if (disposed) stop();
                else unlisten = stop;
            });
    });
    onUnmounted(() => {
        disposed = true;
        for (const timer of timers) clearInterval(timer);
        timers.clear();
        if (timer) clearInterval(timer);
        unlisten?.();
    });
</script>

<template>
    <section class="pb-1" data-testid="settings-usage-dashboard">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div
                v-for="card in cards"
                :key="card.key"
                :data-testid="`settings-usage-card-${card.key}`"
                :title="card.description"
                class="flex min-w-0 flex-col gap-1 rounded-[10px] bg-neutral-50/80 px-4 py-3"
            >
                <span class="truncate text-xs text-neutral-500">{{ card.label }}</span>
                <span
                    class="truncate font-serif text-[22px] leading-tight font-semibold text-neutral-950 tabular-nums"
                    :title="`${card.prefix ?? ''}${card.value}`"
                >
                    <template v-if="card.counter">
                        <span v-if="card.prefix" class="mr-0.5">{{ card.prefix }}</span>
                        <AnimatedCounter
                            v-bind="card.counter"
                            :animate-on-view="true"
                            :locale="getLocale()"
                        />
                    </template>
                    <template v-else-if="card.valueParts">
                        <span
                            v-for="part in card.valueParts"
                            :key="part.unit"
                            class="mr-1.5 inline-flex items-baseline gap-0.5 last:mr-0"
                        >
                            {{ part.value }}
                            <span class="text-[15px] font-normal text-neutral-400">
                                {{ part.unit }}
                            </span>
                        </span>
                    </template>
                    <template v-else>{{ card.prefix }}{{ card.value }}</template>
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
            v-if="secondaryMetrics.length"
            class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7"
        >
            <div
                v-for="item in secondaryMetrics"
                :key="item.key"
                :data-testid="`settings-usage-metric-${item.key}`"
                :title="item.note"
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

        <div class="mt-3 rounded-[11px] bg-neutral-50/80 p-3">
            <div class="flex items-start justify-between gap-3">
                <div class="flex flex-col gap-0.5">
                    <span class="text-[10px] tracking-wide text-neutral-400 uppercase">
                        {{ t('settings.usage.dashboardCurveTitle') }}
                    </span>
                    <!-- 有流时说明当前是最近一分钟，单位已在右侧标注，这里不再重复 -->
                    <span v-if="liveMode" class="text-[10px] text-neutral-400">
                        {{ t('settings.usage.curve.liveWindow') }}
                    </span>
                </div>

                <!-- 右上角始终给吞吐：有流时是实时值，空闲时是区间平均值 -->
                <div class="flex flex-col items-end gap-0.5">
                    <div class="flex items-baseline gap-1.5">
                        <span
                            class="font-serif text-[22px] leading-none font-semibold tabular-nums"
                            :class="anyStreaming ? 'text-neutral-950' : 'text-neutral-400'"
                        >
                            {{ speedDisplay }}
                        </span>
                        <span class="text-[11px] text-neutral-400">tok/s</span>
                    </div>
                    <span class="text-[10px] text-neutral-400">
                        {{
                            anyStreaming
                                ? t('settings.usage.curve.liveSpeed')
                                : t('settings.usage.curve.avgSpeed')
                        }}
                    </span>
                </div>
            </div>
            <!--
                实时流与历史曲线是两种不同的东西：
                有流时交给 RealtimeStream（右边缘永远是「此刻」，逐帧向左滑，线头呼吸）；
                否则用 LineChart 画按桶聚合的历史曲线。
            -->
            <RealtimeStream
                v-if="liveMode"
                class="mt-1"
                :points="livePoints"
                :label="t('settings.usage.dashboardCurveTitle')"
                :window-ms="zoomWindowMs * 1000"
                :streaming="anyStreaming"
                :height="132"
                :format-value="formatCurveValue"
                :format-tick="formatCurveValue"
            />
            <LineChart
                v-else-if="curveData.length > 0"
                class="mt-1"
                :data="curveData"
                :series="[{ key: 'value', label: curveUnit }]"
                :label="t('settings.usage.dashboardCurveTitle')"
                :height="132"
                :curve="'smooth'"
                :legend="false"
                :format-value="formatCurveValue"
                :format-tick="formatCurveValue"
            />

            <!-- 左下角：会话数（有流时是活跃路数，空闲时是区间会话数） -->
            <div class="mt-3 flex items-center gap-1.5 text-[11px] text-neutral-500">
                <span
                    class="h-1.5 w-1.5 rounded-full"
                    :class="anyStreaming ? 'animate-pulse bg-sky-500' : 'bg-neutral-300'"
                    aria-hidden="true"
                />
                <span v-if="anyStreaming">
                    {{
                        t('settings.usage.live.activeSessions', {
                            count: aggregate.activeCount,
                        })
                    }}
                </span>
                <span v-else>
                    {{
                        t('settings.usage.curve.sessionCount', {
                            count: formatInt(summary?.sessionCount ?? 0),
                        })
                    }}
                </span>
            </div>
        </div>
    </section>
</template>
