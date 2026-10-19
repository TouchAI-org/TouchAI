<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import {
        AppEvent,
        eventService,
        type SessionTaskUsageProgressEvent,
        type UsageThroughputSample,
    } from '@services/EventService';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { t } from '@/i18n';

    import { formatCost, formatDuration, formatTokensCompact } from '../utils/format';
    import { aggregateStreams, isStale, shouldDropFinishedStreams } from '../utils/liveAggregate';

    defineOptions({ name: 'UsageLive' });

    /** 曲线采样节拍；比事件推送慢，避免高频重绘 */
    const SAMPLE_INTERVAL_MS = 500;
    /** 曲线容量 */
    const MAX_SAMPLES = 60;
    /** 全部结束后保留最终快照的时长，超过就清空等下一轮 */
    const LINGER_MS = 60_000;

    /**
     * 每路流的最新状态，按 taskId 索引。
     *
     * 一个会话同时只有一个任务，但不同会话可以并行，所以这里必须用 Map
     * 而不是单个对象——否则两路流会互相覆盖，面板在两份数字之间跳。
     */
    const streams = ref(new Map<string, SessionTaskUsageProgressEvent>());
    /** 各流最近一次更新的时间，用于清理陈旧条目 */
    const lastSeenAt = new Map<string, number>();
    /** 聚合吞吐曲线 */
    const samples = ref<UsageThroughputSample[]>([]);

    let unlisten: (() => void) | null = null;
    let sampleTimer: ReturnType<typeof setInterval> | null = null;
    let curveStartedAt = 0;

    const activeList = computed(() => [...streams.value.values()]);

    const aggregate = computed(() => aggregateStreams(activeList.value));

    const activeCount = computed(() => aggregate.value.activeCount);

    const anyStreaming = computed(() => aggregate.value.anyStreaming);

    /** 停止后保留最后一次聚合速度，避免数字瞬间变回 '—' */
    const lastAggregateSpeed = ref<number | null>(null);

    const speedText = computed(() => {
        // 结束后没有活跃流，退回最后一次算出的速度，便于回头看结果
        const speed = aggregate.value.speed ?? lastAggregateSpeed.value;
        if (speed === null || !Number.isFinite(speed)) {
            return '—';
        }
        return speed.toFixed(1);
    });

    const totalTokens = computed(() => aggregate.value.totalTokens);

    const totalCostMicros = computed(() => aggregate.value.totalCostMicros);

    const elapsedText = computed(() => {
        const totalSeconds = Math.floor(aggregate.value.elapsedMs / 1000);
        return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
    });

    const firstTtftMs = computed(() => aggregate.value.ttftMs);

    /** 多路并行时列出模型名，超出部分折成 +N */
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
        const spanMs = Math.max(1, (items[items.length - 1]?.atMs ?? 0) - (items[0]?.atMs ?? 0));
        const step = items.length > 1 ? innerWidth / (items.length - 1) : 0;

        return items.map((item, index) => ({
            x: PADDING.left + (items.length > 1 ? index * step : innerWidth / 2),
            y: PADDING.top + innerHeight - (item.tokensPerSecond / peak) * innerHeight,
            ratio: (item.atMs - (items[0]?.atMs ?? 0)) / spanMs,
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
        if (speed === null || !Number.isFinite(speed) || speed <= 0) {
            return;
        }

        if (curveStartedAt === 0) {
            curveStartedAt = Date.now();
        }

        lastAggregateSpeed.value = speed;
        samples.value = [
            ...samples.value,
            { atMs: Date.now() - curveStartedAt, tokensPerSecond: speed },
        ].slice(-MAX_SAMPLES);
    }

    function resetCurve() {
        samples.value = [];
        curveStartedAt = 0;
        lastAggregateSpeed.value = null;
    }

    /** 丢掉已结束且久未更新的流，避免陈旧数字一直计入合计 */
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

        // 全部结束并清理干净后，曲线也一并归零
        if (streams.value.size === 0 && samples.value.length > 0) {
            resetCurve();
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

                // 新一轮开始时先清掉已结束的旧流，免得上一轮的 token 累加到这一轮
                if (shouldDropFinishedStreams([...streams.value.values()], isNewStream)) {
                    streams.value.clear();
                    lastSeenAt.clear();
                    resetCurve();
                }

                streams.value.set(payload.taskId, payload);
                lastSeenAt.set(payload.taskId, Date.now());
                // Map 本身不是响应式的，换引用触发更新
                streams.value = new Map(streams.value);
            })
            .then((stop) => {
                unlisten = stop;
            });
    });

    onUnmounted(() => {
        if (sampleTimer) {
            clearInterval(sampleTimer);
            sampleTimer = null;
        }
        unlisten?.();
        unlisten = null;
    });
</script>

<template>
    <section class="settings-row-group p-4" data-testid="settings-usage-live">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 text-[13px] text-neutral-950">
                    {{ t('settings.usage.live.title') }}
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

            <div class="flex items-baseline gap-1.5">
                <span
                    class="font-serif text-[26px] leading-none font-semibold tabular-nums"
                    :class="anyStreaming ? 'text-neutral-950' : 'text-neutral-300'"
                >
                    {{ speedText }}
                </span>
                <span class="text-[11px] text-neutral-400">tok/s</span>
            </div>
        </div>

        <div class="mt-3 rounded-[11px] bg-neutral-50/80 p-3">
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
                    {{ t('settings.usage.live.activeStreams', { count: activeCount }) }}
                </span>
            </div>
        </div>

        <div class="mt-3 grid grid-cols-3 gap-3">
            <div class="flex items-baseline justify-between gap-2">
                <span class="text-[11px] text-neutral-500">
                    {{ t('settings.usage.live.total') }}
                </span>
                <span
                    class="text-[13px] text-neutral-900 tabular-nums"
                    :title="String(totalTokens)"
                >
                    {{ formatTokensCompact(totalTokens) }}
                </span>
            </div>
            <div class="flex items-baseline justify-between gap-2">
                <span class="text-[11px] text-neutral-500">
                    {{ t('settings.usage.live.elapsed') }}
                </span>
                <span class="text-[13px] text-neutral-900 tabular-nums">{{ elapsedText }}</span>
            </div>
            <div class="flex items-baseline justify-between gap-2">
                <span class="text-[11px] text-neutral-500">
                    {{ t('settings.usage.live.cost') }}
                </span>
                <span class="text-[13px] text-neutral-900 tabular-nums">
                    {{ totalCostMicros === null ? '—' : `≈ ${formatCost(totalCostMicros)}` }}
                </span>
            </div>
        </div>

        <p class="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11px] text-neutral-400">
            <AppIcon name="information-circle" class="h-3 w-3 shrink-0" />
            {{ t('settings.usage.live.estimateNote') }}
            <template v-if="firstTtftMs !== null">
                · {{ t('settings.usage.live.ttft', { value: formatDuration(firstTtftMs) }) }}
            </template>
            <template v-if="!anyStreaming && activeList.length > 0">
                · {{ t('settings.usage.live.stopped') }}
            </template>
        </p>
    </section>
</template>
