<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
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
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { t } from '@/i18n';

    import {
        formatActiveDuration,
        formatCost,
        formatDuration,
        formatInt,
        formatPercent,
        formatTokensCompact,
    } from '../utils/format';
    import { aggregateStreams } from '../utils/liveAggregate';
    import { buildUsageCurve, mergeLiveUsage } from '../utils/usageOverlay';

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
    const liveSamples = ref<Array<{ atMs: number; tokens: number }>>([]);
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
        description?: string;
    }
    const cards = computed<Card[]>(() => {
        const value = summary.value;
        return [
            {
                key: 'cost',
                label: t('settings.usage.metric.cost'),
                value: formatCost(value?.totalCostMicros ?? 0),
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
                note: t('settings.usage.metric.requestsNote', {
                    rate: formatPercent(value?.successRate ?? 0),
                }),
            },
            {
                key: 'sessions',
                label: t('settings.usage.metric.sessions'),
                value: formatInt(value?.sessionCount ?? 0),
                note: t('settings.usage.metric.sessionsNote'),
            },
            {
                key: 'tokens',
                label: t('settings.usage.metric.tokens'),
                value: formatTokensCompact(value?.realTotalTokens ?? 0),
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

    const curve = computed(() =>
        buildUsageCurve(
            props.trend,
            props.bucket,
            props.range,
            props.liveTurns,
            liveStates.value,
            liveSamples.value,
            now.value
        )
    );
    const WIDTH = 520;
    const HEIGHT = 96;
    const geometry = computed(() => {
        const points = curve.value;
        if (!points.length) return [];
        const peak = Math.max(1, ...points.map((point) => point.value));
        const first = points[0]!.at;
        const span = points[points.length - 1]!.at - first;
        return points.map((point) => ({
            ...point,
            x: span > 0 ? 4 + ((point.at - first) / span) * (WIDTH - 8) : WIDTH / 2,
            y: 8 + (1 - point.value / peak) * (HEIGHT - 12),
        }));
    });
    const linePath = computed(() =>
        geometry.value
            .map(
                (point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`
            )
            .join(' ')
    );
    const areaPath = computed(() => {
        const first = geometry.value[0];
        const last = geometry.value[geometry.value.length - 1];
        return first && last
            ? `${linePath.value} L${last.x.toFixed(1)},${HEIGHT - 4} L${first.x.toFixed(1)},${HEIGHT - 4} Z`
            : '';
    });

    onMounted(() => {
        timer = setInterval(() => {
            now.value = Date.now();

            // 按 500ms 节拍记录本轮累计输出；曲线尾靠它向右延伸。
            const total = [...streams.value.values()].reduce(
                (sum, stream) => sum + stream.outputTokens,
                0
            );
            if (total > 0) {
                const previous = liveSamples.value[liveSamples.value.length - 1];
                if (!previous || total !== previous.tokens) {
                    liveSamples.value = [
                        ...liveSamples.value,
                        { atMs: now.value, tokens: total },
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
                    <template v-if="card.valueParts">
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
            class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
        >
            <div
                v-for="item in secondaryMetrics"
                :key="item.key"
                :data-testid="`settings-usage-metric-${item.key}`"
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
                <span class="pt-0.5 text-[10px] tracking-wide text-neutral-400 uppercase">
                    {{ t('settings.usage.dashboardCurveTitle') }} ·
                    {{ t('settings.usage.metric.tokens') }}
                </span>

                <!-- 有流时右上角给吞吐与路数；无流时只留一个安静的状态点 -->
                <div class="flex flex-col items-end gap-0.5">
                    <div v-if="anyStreaming" class="flex items-baseline gap-1.5">
                        <span
                            class="font-serif text-[22px] leading-none font-semibold text-neutral-950 tabular-nums"
                        >
                            {{ aggregate.speed === null ? '—' : aggregate.speed.toFixed(1) }}
                        </span>
                        <span class="text-[11px] text-neutral-400">tok/s</span>
                    </div>
                    <span
                        class="flex items-center gap-1.5 text-[11px]"
                        :class="anyStreaming ? 'text-neutral-600' : 'text-neutral-400'"
                    >
                        <span
                            class="h-1.5 w-1.5 rounded-full"
                            :class="anyStreaming ? 'animate-pulse bg-sky-500' : 'bg-neutral-300'"
                            aria-hidden="true"
                        />
                        <template v-if="anyStreaming">
                            {{
                                t('settings.usage.live.activeSessions', {
                                    count: aggregate.activeCount,
                                })
                            }}
                        </template>
                        <template v-else>{{ t('settings.usage.live.idle') }}</template>
                    </span>
                </div>
            </div>
            <svg
                v-if="geometry.length"
                :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
                :height="HEIGHT"
                class="mt-1 w-full"
                role="img"
                :aria-label="t('settings.usage.dashboardCurveTitle')"
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
        </div>
    </section>
</template>
