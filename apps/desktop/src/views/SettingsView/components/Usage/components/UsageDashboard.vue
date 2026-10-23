<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AnimatedCounter from '@components/ui/animated-counter/AnimatedCounter.vue';
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
        tokensParts,
    } from '../utils/format';
    import { aggregateStreams } from '../utils/liveAggregate';
    import { compressRatio, formatAxisValue, liveAxis } from '../utils/liveAxis';
    import { smoothThrough } from '../utils/smoothCurve';
    import {
        buildLiveCurve,
        buildUsageCurve,
        LIVE_WINDOW_MS,
        mergeLiveUsage,
        type UsageCurvePoint,
    } from '../utils/usageOverlay';

    interface Props {
        summary: UsageSummary | null;
        trend: UsageTrendPoint[];
        bucket: UsageBucket;
        /** Real bucket width in ms; rate conversion needs it, the kind is not enough. */
        bucketMs: number;
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
     * Live samples: cumulative output for the current stream.
     *
     * Speed is derived on read; storing it would draw a curve unrelated to the
     * cumulative total.
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
        /*
         * Read the stream events directly instead of requiring them to appear
         * in liveTurns first.
         *
         * liveTurns comes from a query over persisted turns, and the running
         * turn has not been written yet, so it is absent. Using it as a
         * whitelist kept anyStreaming false and pinned the curve to history.
         */
        return aggregateStreams([...streams.value.values()]);
    });
    const anyStreaming = computed(() => aggregate.value.anyStreaming);
    const summary = computed(() =>
        props.summary ? mergeLiveUsage(props.summary, props.liveTurns, liveStates.value) : null
    );
    const activityParts = computed(() => formatActiveDuration(summary.value?.totalDurationMs ?? 0));

    /**
     * Card values split into number and unit.
     *
     * Same rule as the active duration: serif digits, unit one step down and
     * dimmed, so all six cards read with the same rhythm. Without it one card
     * carries `42分 32秒` while another shows a bare `577.1万`.
     */
    interface Card {
        key: string;
        label: string;
        value: string;
        prefix?: string;
        note: string;
        warn?: boolean;
        valueParts?: Array<{ value: string; unit: string }>;
        /** Counter config; when absent the plain `value` is shown. */
        counter?: CounterSpec;
        description?: string;
    }
    function tokenParts(tokens: number): Array<{ value: string; unit: string }> {
        const parts = tokensParts(tokens);
        return parts.unit
            ? [{ value: parts.value, unit: parts.unit }]
            : [{ value: parts.value, unit: '' }];
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
                valueParts: tokenParts(value?.realTotalTokens ?? 0),
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
                valueParts: tokenParts(value?.cacheReadTokens ?? 0),
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
     * Mean RPM: requests per active minute.
     *
     * The calendar span is not the denominator: a personal assistant issues a
     * couple of hundred requests a month, so dividing by 30 days always yields
     * 0.00 and says nothing. Turn durations answer "how many requests went out
     * per minute of real conversation", on the same basis as active duration.
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
        // Small blocks use raw numbers: at 11px, `5,600` reads better than `5.6千`.
        const items: Array<{
            key: string;
            label: string;
            value: string;
            unit: string;
            raw?: number;
            note?: string;
            /** When true this block is not rendered, e.g. a field the provider never reports. */
            hidden?: boolean;
        }> = [
            {
                key: 'input',
                label: t('settings.usage.metric.freshInput'),
                ...rawCount(value.inputTokens),
                raw: value.inputTokens,
            },
            {
                key: 'output',
                label: t('settings.usage.metric.output'),
                ...rawCount(value.outputTokens),
                raw: value.outputTokens,
            },
            {
                key: 'cacheWrite',
                label: t('settings.usage.metric.cacheWrite'),
                ...rawCount(value.cacheWriteTokens),
                raw: value.cacheWriteTokens,
            },
            {
                key: 'ttft',
                label: t('settings.usage.metric.ttft'),
                value: formatDuration(value.meanTtftMs),
                unit: '',
                note: t('settings.usage.metric.ttftNote'),
            },
            {
                key: 'ttftP90',
                label: t('settings.usage.metric.firstText'),
                value: formatDuration(value.meanFirstTextMs ?? null),
                unit: '',
                note: t('settings.usage.metric.firstTextNote'),
            },
            {
                key: 'rpm',
                label: t('settings.usage.metric.rpm'),
                value: averageRpm.value,
                // Add the unit, otherwise this block is a bare number beside rows carrying s or ms.
                unit: t('settings.usage.metric.rpmUnit'),
            },
        ];
        if (value.reasoningTokens > 0)
            items.splice(2, 0, {
                key: 'reasoning',
                label: t('settings.usage.metric.reasoning'),
                ...rawCount(value.reasoningTokens),
                raw: value.reasoningTokens,
            });
        return items;
    });

    /**
     * Token count for a secondary block.
     *
     * Raw digits below ten thousand read better at 11px than an abbreviated
     * form; from 万 upward the raw number has six or seven digits and no longer
     * fits, so the unit takes over.
     */
    function rawCount(tokens: number): { value: string; unit: string } {
        const parts = tokensParts(tokens);
        // Skip the 千 step: five digits still read fine and the abbreviation hurts.
        return parts.unit === '千' || parts.unit === 'K'
            ? { value: formatInt(tokens), unit: '' }
            : parts;
    }

    /**
     * When the view counts as live.
     *
     * Always while streaming, and for another 15 seconds afterwards so the last
     * stretch can be read before the axis widens back to the range.
     */
    const GRACE_MS = 15_000;
    const graceUntil = ref(0);
    watch(anyStreaming, (streaming) => {
        if (streaming) {
            graceUntil.value = 0;
            return;
        }
        if (liveSamples.value.length > 0) graceUntil.value = Date.now() + GRACE_MS;
    });

    const liveMode = computed(
        () => liveSamples.value.length > 0 && (anyStreaming.value || now.value < graceUntil.value)
    );

    /**
     * Scale transition: 0 is the whole range, 1 is the 15-second live window.
     *
     * These are not two charts but two window lengths on one axis. Shrinking the
     * window from the full range to 15 seconds reads as a camera push-in, with
     * no crossfade between layers.
     */
    const ZOOM_MS = 760;
    const zoom = ref(0);
    let zoomRaf = 0;
    let zoomFrom = 0;
    let zoomTo = 0;
    let zoomStart = 0;

    /** easeInOutCubic: slow at both ends, fast in the middle, like a camera move. */
    function ease(t: number): number {
        return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    }

    function animateZoom(target: number): void {
        if (zoomRaf) cancelAnimationFrame(zoomRaf);
        zoomFrom = zoom.value;
        zoomTo = target;
        zoomStart = performance.now();

        const step = (): void => {
            const elapsed = performance.now() - zoomStart;
            const progress = Math.min(1, elapsed / ZOOM_MS);
            zoom.value = zoomFrom + (zoomTo - zoomFrom) * ease(progress);
            if (progress < 1) {
                zoomRaf = requestAnimationFrame(step);
            } else {
                zoom.value = zoomTo;
                zoomRaf = 0;
            }
        };
        zoomRaf = requestAnimationFrame(step);
    }

    watch(
        liveMode,
        (active) => {
            // Stop scheduling frames once the component is gone.
            if (disposed) return;
            animateZoom(active ? 1 : 0);
        },
        { immediate: true }
    );

    /**
     * Seconds covered by one bucket.
     *
     * History returns tokens per bucket while the header and the live tail use
     * tokens per second. Plotting both on one line makes `18.3万` on the chart
     * look like it contradicts `53.7 tok/s` in the header. Converting history to
     * a rate puts the chart, the header, and the tooltip on one basis.
     */
    /** Bucket width in seconds, taken from the query layer instead of a fixed set. */
    const bucketSeconds = computed(() => Math.max(1, Math.round(props.bucketMs / 1000)));

    /** History curve: tokens per bucket converted to tokens per second. */
    const historyCurve = computed(() =>
        buildUsageCurve(
            props.trend,
            props.bucket,
            props.range,
            props.liveTurns,
            liveStates.value,
            [],
            Date.now(),
            // Real bucket width: the query layer derives it, so the kind cannot be reversed.
            props.bucketMs
        ).map((point) => ({ ...point, value: point.value / bucketSeconds.value }))
    );

    /** Live curve: the last 15 seconds of rate. */
    const liveCurve = computed(() =>
        liveSamples.value.length > 0
            ? buildLiveCurve(liveSamples.value, LIVE_WINDOW_MS, now.value)
            : []
    );

    /**
     * Window length, shrinking from the full range to 15 seconds.
     *
     * This drives the transition: no chart swap, only the window on one axis.
     * As the window closes from a day to 15 seconds, history slides off the left
     * while the live tail fills the frame, which reads as a push-in.
     */
    const windowMs = computed(() => {
        const history = historyCurve.value;
        const first = history[0]?.at ?? now.value;
        const last = history[history.length - 1]?.at ?? now.value;
        const span = Math.max(LIVE_WINDOW_MS, last - first);
        return span + (LIVE_WINDOW_MS - span) * zoom.value;
    });

    /** Window start in real time. */
    const windowStart = computed(() => {
        if (zoom.value >= 1) return now.value - LIVE_WINDOW_MS;
        // The right edge tracks the present during the transition, so the left edge keeps moving out.
        return Math.min(
            now.value - LIVE_WINDOW_MS,
            Math.max(now.value - windowMs.value, historyCurve.value[0]?.at ?? 0)
        );
    });

    /**
     * Merge the two sources.
     *
     * Only merged during the transition (zoom < 1), while the axis still spans
     * a day and history is needed to fill the left side that the push-in will
     * slide away.
     *
     * Fully live (zoom >= 1) uses the live points alone: a bucket average and an
     * instantaneous rate differ by orders of magnitude, and sharing one axis
     * would flatten the live tail against the floor.
     */
    const curve = computed<UsageCurvePoint[]>(() => {
        const start = windowStart.value;
        const source =
            zoom.value >= 1 ? liveCurve.value : [...historyCurve.value, ...liveCurve.value];

        const points = source
            .filter((point) => point.at >= start && point.at <= now.value)
            .sort((left, right) => left.at - right.at);

        /*
         * Draw a flat line on zero instead of leaving the plot empty.
         *
         * The rate really is zero, so the line belongs there; a blank plot reads
         * as a broken chart. The right edge uses the window end rather than now,
         * because now keeps advancing in history mode and would stretch the line
         * as if something were running.
         */
        if (points.length === 0) {
            const right = zoom.value >= 1 ? now.value : Math.min(now.value, start + windowMs.value);
            return [
                { key: '', at: start, value: 0, live: true },
                { key: '', at: right, value: 0, live: true },
            ];
        }

        return points;
    });
    /**
     * Curve geometry.
     *
     * The x axis follows real time, so narrowing the window stretches the curve
     * instead of squeezing old points to the left.
     *
     * The y axis is a square-root compression (see liveAxis). A cold start
     * often bursts to several hundred tok/s and pins everything else to the
     * floor on a linear scale; compressing lifts the low end so the movement is
     * visible while tick labels keep true values.
     */
    /**
     * Canvas size.
     *
     * The width must match the container: with a fixed 520 the SVG scales
     * proportionally and centres itself inside a wider box, leaving margins and
     * breaking the pointer mapping. A ResizeObserver measures the real width, so
     * resizing the window recomputes the curve.
     */
    const HEIGHT = 96;
    const PLOT_TOP = 8;
    const PLOT_BOTTOM = HEIGHT - 4;

    const plotRef = ref<HTMLElement | null>(null);
    const plotWidth = ref(520);
    let plotObserver: ResizeObserver | null = null;

    onMounted(() => {
        const el = plotRef.value;
        if (!el) return;
        plotWidth.value = el.clientWidth || 520;
        // jsdom has no ResizeObserver; the default width is fine under test.
        if (typeof ResizeObserver === 'undefined') return;
        plotObserver = new ResizeObserver((entries) => {
            const next = entries[0]?.contentRect.width ?? 0;
            if (next > 0) plotWidth.value = next;
        });
        plotObserver.observe(el);
    });

    /**
     * One compressed axis for both modes.
     *
     * Bucket rates also vary hugely, from near-empty hours to full ones, and a
     * linear scale flattens most of them; using different algorithms per mode
     * would also snap the axis during the transition.
     */
    const axis = computed(() => liveAxis(curve.value.map((point) => point.value)));

    /** Value to plot-height fraction (0 at the bottom, 1 at the top). */
    function heightRatio(value: number): number {
        return Math.min(1, compressRatio(value, axis.value.max));
    }

    const geometry = computed(() => {
        const points = curve.value;
        if (!points.length) return [];
        const first = points[0]!.at;
        const span = points[points.length - 1]!.at - first;
        return points.map((point) => ({
            ...point,
            x:
                span > 0
                    ? 4 + ((point.at - first) / span) * (plotWidth.value - 8)
                    : plotWidth.value - 4,
            y: PLOT_BOTTOM - heightRatio(point.value) * (PLOT_BOTTOM - PLOT_TOP),
        }));
    });

    /**
     * Smooth curve.
     *
     * Monotone cubic interpolation: the curve never overshoots a segment, so a
     * spike has no invented dip either side, and points join in a rounded line
     * instead of straight segments.
     */
    const linePath = computed(() => {
        const points = geometry.value;
        if (points.length === 0) return '';
        if (points.length === 1) {
            const only = points[0]!;
            return `M${only.x.toFixed(1)},${only.y.toFixed(1)}`;
        }

        // Normalise x to 0..1 before running the monotone interpolator.
        const firstX = points[0]!.x;
        const lastX = points[points.length - 1]!.x;
        const spanX = lastX - firstX || 1;
        const normalized: Array<[number, number]> = points.map((point) => [
            (point.x - firstX) / spanX,
            point.y,
        ]);

        const smooth = smoothThrough(normalized);
        return smooth
            .map(([x, y], index) => {
                const px = firstX + x * spanX;
                return `${index === 0 ? 'M' : 'L'}${px.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(' ');
    });

    /** The area closes the same path down to the baseline, so line and fill stay in sync. */
    const areaPath = computed(() => {
        const first = geometry.value[0];
        const last = geometry.value[geometry.value.length - 1];
        return first && last
            ? `${linePath.value} L${last.x.toFixed(1)},${HEIGHT - 4} L${first.x.toFixed(1)},${HEIGHT - 4} Z`
            : '';
    });

    /** Axis ticks from the compressed scale, shared by both modes. */
    const axisTicks = computed(() =>
        axis.value.ticks.map((tick) => ({
            key: tick.value,
            label: formatAxisValue(tick.value),
            top: PLOT_BOTTOM - tick.ratio * (PLOT_BOTTOM - PLOT_TOP),
        }))
    );

    /** Axis unit: tokens per second in both modes, matching the header. */
    const curveUnit = 'tok/s';

    /** Format an axis or tooltip value. */
    function formatCurveValue(value: number): string {
        return formatAxisValue(value);
    }

    /**
     * Curve hover: snap to the nearest sample.
     *
     * The crosshair follows the pointer while the reading comes from the nearest
     * point, so parking between two samples still gives a definite value.
     */
    const curveActive = ref<number | null>(null);

    const activePoint = computed(() => {
        if (curveActive.value === null) return null;
        return geometry.value[curveActive.value] ?? null;
    });

    /**
     * Tooltip position, in percentages of the curve container so it scales
     * with the window. Positioning against the card would offset it, because
     * the curve occupies only the right part of the card.
     */
    const tooltipStyle = computed(() => {
        const point = activePoint.value;
        if (!point) return {};
        const ratio = point.x / plotWidth.value;
        // Flip to the left near the right edge so the tooltip is not clipped.
        return ratio > 0.62
            ? { right: `${(1 - ratio) * 100}%`, marginRight: '8px' }
            : { left: `${ratio * 100}%`, marginLeft: '8px' };
    });

    function onCurvePointer(event: PointerEvent): void {
        const el = event.currentTarget as SVGElement | null;
        if (!el || geometry.value.length === 0) return;
        const rect = el.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * plotWidth.value;

        // Find the nearest point by real screen distance, not by index rounding.
        let best = 0;
        let bestDistance = Infinity;
        geometry.value.forEach((point, index) => {
            const distance = Math.abs(point.x - x);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = index;
            }
        });
        curveActive.value = best;
    }

    function onCurveKeydown(event: KeyboardEvent): void {
        if (geometry.value.length === 0) return;
        const current = curveActive.value ?? geometry.value.length - 1;
        if (event.key === 'ArrowLeft') {
            curveActive.value = Math.max(0, current - 1);
            event.preventDefault();
        } else if (event.key === 'ArrowRight') {
            curveActive.value = Math.min(geometry.value.length - 1, current + 1);
            event.preventDefault();
        } else if (event.key === 'Escape') {
            curveActive.value = null;
        }
    }

    /**
     * Tooltip timestamp. Granularity follows the bucket, not the clock: a day
     * bucket labels the date, an hour bucket adds the hour, and a sub-hour
     * bucket adds seconds. A clock-only label on a multi-day range would read
     * the same on every day.
     */
    function formatPointTime(at: number): string {
        const date = new Date(at);
        const pad = (value: number) => String(value).padStart(2, '0');
        const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
        const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

        if (props.bucketMs >= 86_400_000) return day;
        if (props.bucketMs >= 3_600_000) return `${day} ${clock}`;
        return `${clock}:${pad(date.getSeconds())}`;
    }

    /**
     * Throughput readout: live speed while streaming, range mean when idle.
     *
     * Leaving the header empty when idle would hide how fast the period was;
     * `decodeSpeed` (output tokens over mean duration) answers exactly that.
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
             * Sample the tracker's own rate instead of differencing cumulative
             * tokens. Differencing fails twice: a tick often lands on an
             * unchanged value and reports 0, and the final switch from estimate
             * to measured usage produces one huge jump. The tracker already
             * computes a sliding-window rate, which also matches the header.
             */
            const speed = aggregate.value.speed;
            const total = aggregate.value.totalTokens;

            /*
             * Record a point whenever output is streaming, whatever the
             * running total. Gating on a non-zero total or an existing sample
             * meant the first point was never written before the first token,
             * so liveMode stayed false and the curve never left history.
             */
            if (anyStreaming.value || liveSamples.value.length > 0) {
                liveSamples.value = [
                    ...liveSamples.value,
                    { atMs: now.value, tokens: total, speed: speed ?? 0 },
                ].slice(-600);
            }

            // Only prune snapshots that finished and were taken over by the summary; keep final events until a refresh lands.
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
        }, 200);
        void eventService
            .on(AppEvent.SESSION_TASK_USAGE_PROGRESS, (payload) => {
                streams.value.set(payload.taskId, payload);
                seenAt.set(payload.taskId, Date.now());
                now.value = Date.now();
                streams.value = new Map(streams.value);
                /*
                 * A new task does not clear the samples. Starting another
                 * request within 15 seconds of the previous one would erase the
                 * stretch just drawn and restart from nothing. Samples are
                 * already clipped to the window, so old ones fall off the left
                 * edge on their own.
                 */
                if (!payload.streaming) emit('track-tasks', [...streams.value.keys()]);
            })
            .then((stop) => {
                if (disposed) stop();
                else unlisten = stop;
            });
    });
    onUnmounted(() => {
        disposed = true;
        if (timer) clearInterval(timer);
        timer = null;
        if (zoomRaf) cancelAnimationFrame(zoomRaf);
        zoomRaf = 0;
        plotObserver?.disconnect();
        plotObserver = null;
        unlisten?.();
        unlisten = null;
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
                class="flex min-w-0 flex-col gap-1 rounded-control bg-neutral-50/80 px-4 py-3"
            >
                <span class="truncate text-xs text-neutral-500">{{ card.label }}</span>
                <span
                    class="truncate font-serif text-title leading-tight font-semibold text-neutral-950 tabular-nums"
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
                            <span class="text-reading font-normal text-neutral-400">
                                {{ part.unit }}
                            </span>
                        </span>
                    </template>
                    <template v-else>{{ card.prefix }}{{ card.value }}</template>
                </span>
                <span
                    class="truncate text-caption"
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
                class="flex min-w-0 flex-col gap-0.5 rounded-action bg-neutral-50/60 px-3 py-2"
            >
                <span class="truncate text-caption text-neutral-500">{{ item.label }}</span>
                <span class="truncate text-compact text-neutral-900 tabular-nums">
                    {{ item.value }}
                    <span v-if="item.unit" class="ml-0.5 text-caption text-neutral-400">
                        {{ item.unit }}
                    </span>
                </span>
            </div>
        </div>

        <div class="mt-3 rounded-[11px] bg-neutral-50/80 p-3">
            <div class="flex items-start justify-between gap-3">
                <div class="flex flex-col gap-0.5">
                    <span class="text-2xs tracking-wide text-neutral-400 uppercase">
                        {{ t('settings.usage.dashboardCurveTitle') }}
                    </span>
                    <!-- 有流时只说明当前窗口，不再重复写单位（右上角已有） -->
                    <span v-if="liveMode" class="text-2xs text-neutral-400">
                        {{ t('settings.usage.curve.liveWindow') }}
                    </span>
                </div>

                <!-- 右上角始终给吞吐：有流时是实时值，空闲时是区间平均值 -->
                <div class="flex flex-col items-end gap-0.5">
                    <div class="flex items-baseline gap-1.5">
                        <span
                            class="font-serif text-title leading-none font-semibold tabular-nums"
                            :class="anyStreaming ? 'text-neutral-950' : 'text-neutral-400'"
                        >
                            {{ speedDisplay }}
                        </span>
                        <span class="text-caption text-neutral-400">tok/s</span>
                    </div>
                    <span class="text-2xs text-neutral-400">
                        {{
                            anyStreaming
                                ? t('settings.usage.curve.liveSpeed')
                                : t('settings.usage.curve.avgSpeed')
                        }}
                    </span>
                </div>
            </div>
            <!--
                曲线由一份内联 SVG 画完，实时与历史共用：
                实时模式是最近十几秒的速率，历史模式是按桶聚合的 token。

                面积与曲线必须完全同步：两者用同一条 d，且都不加 CSS 过渡。
                之前给两者加 transition-all，SVG path 的插值路径不一致，
                面积会慢半拍、与线错开。
            -->
            <div class="mt-1 flex gap-2">
                <!--
                    刻度绝对定位，因为压缩轴的刻度不是等距的：
                    用 justify-between 会把它们按均分摆放，与曲线对不上。
                -->
                <div
                    class="relative w-9 shrink-0 text-right text-3xs text-neutral-400 tabular-nums"
                    :style="{ height: `${HEIGHT}px` }"
                    aria-hidden="true"
                >
                    <span
                        v-for="tick in axisTicks"
                        :key="tick.key"
                        class="absolute right-0 -translate-y-1/2 leading-none"
                        :style="{ top: `${tick.top}px` }"
                    >
                        {{ tick.label }}
                    </span>
                </div>

                <div ref="plotRef" class="relative min-w-0 flex-1">
                    <svg
                        v-if="geometry.length"
                        :viewBox="`0 0 ${plotWidth} ${HEIGHT}`"
                        :height="HEIGHT"
                        class="block w-full outline-none"
                        role="application"
                        tabindex="0"
                        :aria-label="t('settings.usage.dashboardCurveTitle')"
                        @pointermove="onCurvePointer"
                        @pointerleave="curveActive = null"
                        @keydown="onCurveKeydown"
                        @blur="curveActive = null"
                    >
                        <!-- 峰值虚线：与左侧刻度对齐 -->
                        <line
                            :x1="0"
                            :x2="plotWidth"
                            :y1="8"
                            :y2="8"
                            stroke="currentColor"
                            class="text-neutral-200/70"
                            stroke-width="1"
                            stroke-dasharray="2 3"
                        />
                        <line
                            :x1="0"
                            :x2="plotWidth"
                            :y1="HEIGHT"
                            :y2="HEIGHT"
                            stroke="currentColor"
                            class="text-neutral-200"
                            stroke-width="1"
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

                        <!-- 悬停：准线 + 高亮点 -->
                        <template v-if="activePoint">
                            <line
                                :x1="activePoint.x"
                                :x2="activePoint.x"
                                y1="0"
                                :y2="HEIGHT"
                                stroke="currentColor"
                                class="text-neutral-400"
                                stroke-width="1"
                                stroke-dasharray="2 2"
                            />
                            <circle
                                :cx="activePoint.x"
                                :cy="activePoint.y"
                                r="3"
                                fill="white"
                                stroke="currentColor"
                                class="text-sky-500"
                                stroke-width="1.6"
                            />
                        </template>
                    </svg>

                    <!--
                    tooltip 与「使用趋势与分布」同一种样式：
                    白底、细边、小圆角，时间在上、读数在下。
                -->
                    <div
                        v-if="activePoint"
                        class="pointer-events-none absolute top-0 z-10 min-w-28 rounded-control border border-neutral-200 bg-white px-3 py-2 text-xs shadow-sm"
                        :style="tooltipStyle"
                        data-testid="usage-curve-tooltip"
                    >
                        <div class="mb-1 text-caption font-medium text-neutral-900">
                            {{ formatPointTime(activePoint.at) }}
                        </div>
                        <div class="flex items-center gap-2">
                            <span
                                class="h-2 w-2 shrink-0 rounded-full bg-sky-500"
                                aria-hidden="true"
                            />
                            <span class="min-w-0 flex-1 truncate text-neutral-600">
                                {{ curveUnit }}
                            </span>
                            <span class="shrink-0 text-neutral-900 tabular-nums">
                                {{ formatCurveValue(activePoint.value) }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 左下角：会话数（有流时是活跃路数，空闲时是区间会话数） -->
            <div class="mt-3 flex items-center gap-1.5 text-caption text-neutral-500">
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
