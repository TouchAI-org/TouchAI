<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import {
        AppEvent,
        eventService,
        type SessionTaskUsageProgressEvent,
    } from '@services/EventService';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { t } from '@/i18n';

    import { formatCost, formatDuration, formatTokensCompact } from '../utils/format';

    defineOptions({ name: 'UsageLive' });

    /** 面板只关心最近一次任务，切换任务即重置曲线 */
    const progress = ref<SessionTaskUsageProgressEvent | null>(null);
    let unlisten: (() => void) | null = null;

    const live = computed(() => {
        const current = progress.value;
        return current !== null && !current.finished && current.activeStreams > 0;
    });

    const speedText = computed(() => {
        const speed = progress.value?.tokensPerSecond;
        if (speed === null || speed === undefined || !Number.isFinite(speed)) {
            return '—';
        }
        return speed.toFixed(1);
    });

    const elapsedText = computed(() => {
        const ms = progress.value?.elapsedMs ?? 0;
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    });

    // ===== 曲线几何 =====

    const VIEW_WIDTH = 520;
    const VIEW_HEIGHT = 96;
    const PADDING = { top: 8, right: 4, bottom: 4, left: 4 };
    const innerWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
    const innerHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;

    const samples = computed(() => progress.value?.samples ?? []);

    const geometry = computed(() => {
        const items = samples.value;
        if (items.length === 0) return [];

        const peak = Math.max(1, ...items.map((item) => item.tokensPerSecond));
        const spanMs = Math.max(1, (items[items.length - 1]?.atMs ?? 0) - (items[0]?.atMs ?? 0));

        // 采样点少时均匀铺开，避免全部挤在左端
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

    onMounted(() => {
        void eventService
            .on(AppEvent.SESSION_TASK_USAGE_PROGRESS, (payload) => {
                // 换任务就换曲线；同一任务的后续推送只在结束时收敛数值
                if (progress.value?.taskId !== payload.taskId) {
                    progress.value = payload;
                    return;
                }

                progress.value = payload;
            })
            .then((stop) => {
                unlisten = stop;
            });
    });

    onUnmounted(() => {
        unlisten?.();
        unlisten = null;
    });
</script>

<template>
    <section class="settings-row-group p-4" data-testid="settings-usage-live">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2">
                <span class="text-[13px] text-neutral-950">
                    {{ t('settings.usage.live.title') }}
                </span>
                <span
                    v-if="progress"
                    class="max-w-56 truncate rounded-full bg-neutral-100 px-2.5 py-0.5 text-[11px] text-neutral-600"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ progress.modelName }}
                </span>
            </div>

            <div class="flex items-baseline gap-1.5">
                <span
                    class="font-serif text-[26px] leading-none font-semibold tabular-nums"
                    :class="live ? 'text-neutral-950' : 'text-neutral-300'"
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
                    :class="live ? 'text-neutral-700' : 'text-neutral-400'"
                >
                    <span
                        class="h-1.5 w-1.5 rounded-full"
                        :class="live ? 'animate-pulse bg-sky-500' : 'bg-neutral-300'"
                        aria-hidden="true"
                    />
                    {{ live ? t('settings.usage.live.online') : t('settings.usage.live.idle') }}
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
                    v-if="geometry.length > 0"
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
                    {{
                        t('settings.usage.live.activeStreams', {
                            count: progress?.activeStreams ?? 0,
                        })
                    }}
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
                    :title="String(progress?.outputTokens ?? 0)"
                >
                    {{ formatTokensCompact(progress?.outputTokens ?? 0) }}
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
                    {{
                        progress?.estimatedCostMicros === null || progress === null
                            ? '—'
                            : `≈ ${formatCost(progress.estimatedCostMicros)}`
                    }}
                </span>
            </div>
        </div>

        <p class="mt-2 flex items-start gap-1.5 text-[11px] text-neutral-400">
            <AppIcon name="information-circle" class="mt-px h-3 w-3 shrink-0" />
            {{ t('settings.usage.live.estimateNote') }}
            <template v-if="progress?.ttftMs !== null && progress">
                · {{ t('settings.usage.live.ttft', { value: formatDuration(progress.ttftMs) }) }}
            </template>
            <template v-if="!live && progress">· {{ t('settings.usage.live.stopped') }}</template>
        </p>
    </section>
</template>
