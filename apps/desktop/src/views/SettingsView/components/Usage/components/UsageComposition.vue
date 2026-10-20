<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageComposition, UsageCompositionSegment } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { formatLongDuration, formatPercent, formatTokensCompact } from '../utils/format';

    const props = defineProps<{ composition: UsageComposition }>();
    defineOptions({ name: 'UsageComposition' });

    /** 与趋势图共用同一套色板，避免同一个模型在两处是两种颜色 */
    const COLORS: Record<string, string> = {
        systemPrompt: 'rgb(63 63 70)',
        toolDefinitions: 'rgb(14 165 233)',
        conversation: 'rgb(16 185 129)',
        toolResults: 'rgb(245 158 11)',
        userPrompt: 'rgb(139 92 246)',
        injections: 'rgb(236 72 153)',
        output: 'rgb(163 163 163)',
        wait: 'rgb(14 165 233)',
        think: 'rgb(139 92 246)',
        reply: 'rgb(63 63 70)',
        tool: 'rgb(16 185 129)',
        other: 'rgb(212 212 212)',
    };

    const LABEL: Record<string, Parameters<typeof t>[0]> = {
        systemPrompt: 'settings.usage.composition.systemPrompt',
        toolDefinitions: 'settings.usage.composition.toolDefinitions',
        conversation: 'settings.usage.composition.conversation',
        toolResults: 'settings.usage.composition.toolResults',
        userPrompt: 'settings.usage.composition.userPrompt',
        injections: 'settings.usage.composition.injections',
        output: 'settings.usage.composition.output',
        wait: 'settings.usage.composition.wait',
        think: 'settings.usage.composition.think',
        reply: 'settings.usage.composition.reply',
        tool: 'settings.usage.composition.tool',
        other: 'settings.usage.composition.other',
    };

    /** 环形几何：半径 34、线宽 10，viewBox 96 */
    const R = 34;
    const STROKE = 10;
    const CIRCUMFERENCE = 2 * Math.PI * R;

    interface Slice {
        key: string;
        label: string;
        color: string;
        value: number;
        ratio: number;
        detail: string;
        dash: string;
        offset: number;
    }

    function buildSlices(
        segments: UsageCompositionSegment[],
        total: number,
        formatValue: (segment: UsageCompositionSegment) => string
    ): Slice[] {
        let consumed = 0;
        return segments.map((segment) => {
            const ratio = total > 0 ? segment.value / total : 0;
            const length = ratio * CIRCUMFERENCE;
            const slice: Slice = {
                key: segment.key,
                label: t(LABEL[segment.key] ?? 'settings.usage.composition.other'),
                color: COLORS[segment.key] ?? 'rgb(163 163 163)',
                value: segment.value,
                ratio,
                detail: `${segment.estimated ? '≈' : ''}${formatValue(segment)}`,
                dash: `${length.toFixed(2)} ${(CIRCUMFERENCE - length).toFixed(2)}`,
                // SVG 从 3 点钟开始，转 -90° 让第一段从 12 点开始
                offset: -consumed,
            };
            consumed += length;
            return slice;
        });
    }

    const tokenSlices = computed(() =>
        buildSlices(props.composition.tokens.segments, props.composition.tokens.total, (segment) =>
            formatTokensCompact(segment.value)
        )
    );

    const timingSlices = computed(() =>
        buildSlices(
            props.composition.timing.segments,
            props.composition.timing.totalMs,
            (segment) => formatLongDuration(segment.value)
        )
    );

    /** 图例分两列，左列前半、右列后半——与参考图的信息密度一致 */
    const tokenColumns = computed(() => splitColumns(tokenSlices.value));
    const timingColumns = computed(() => splitColumns(timingSlices.value));

    function splitColumns(slices: Slice[]): [Slice[], Slice[]] {
        const half = Math.ceil(slices.length / 2);
        return [slices.slice(0, half), slices.slice(half)];
    }
</script>

<template>
    <div class="grid grid-cols-1 gap-3 xl:grid-cols-2" data-testid="settings-usage-composition">
        <!-- Token 构成 -->
        <section class="space-y-3">
            <div class="flex items-baseline justify-between gap-2">
                <h2 class="settings-section-title">
                    {{ t('settings.usage.composition.tokenTitle') }}
                </h2>
                <span class="text-[11px] text-neutral-400">
                    {{
                        t('settings.usage.composition.cacheNote', {
                            rate: formatPercent(composition.cacheReadShare),
                        })
                    }}
                </span>
            </div>

            <div class="rounded-[11px] bg-neutral-50/80 p-4">
                <div v-if="tokenSlices.length === 0" class="py-10 text-center">
                    <span class="text-xs text-neutral-400">
                        {{ t('settings.usage.composition.empty') }}
                    </span>
                </div>

                <div v-else class="flex items-center gap-5">
                    <div class="relative shrink-0">
                        <svg
                            :viewBox="`0 0 96 96`"
                            class="h-[96px] w-[96px] -rotate-90"
                            role="img"
                            :aria-label="t('settings.usage.composition.tokenTitle')"
                        >
                            <circle
                                :cx="48"
                                :cy="48"
                                :r="R"
                                fill="none"
                                stroke="currentColor"
                                class="text-neutral-200/70"
                                :stroke-width="STROKE"
                            />
                            <circle
                                v-for="slice in tokenSlices"
                                :key="slice.key"
                                :cx="48"
                                :cy="48"
                                :r="R"
                                fill="none"
                                :stroke="slice.color"
                                :stroke-width="STROKE"
                                :stroke-dasharray="slice.dash"
                                :stroke-dashoffset="slice.offset"
                                stroke-linecap="butt"
                            />
                        </svg>
                        <div
                            class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
                        >
                            <span
                                class="font-serif text-[15px] leading-none font-semibold text-neutral-950 tabular-nums"
                            >
                                {{ formatTokensCompact(composition.tokens.total) }}
                            </span>
                            <span class="mt-0.5 text-[10px] text-neutral-400">
                                {{ t('settings.usage.composition.totalTokens') }}
                            </span>
                        </div>
                    </div>

                    <div class="grid min-w-0 flex-1 grid-cols-2 gap-x-5 gap-y-2.5 xl:max-w-[420px]">
                        <template v-for="column in tokenColumns" :key="column[0]?.key ?? 'empty'">
                            <div class="min-w-0 space-y-2">
                                <div
                                    v-for="slice in column"
                                    :key="slice.key"
                                    class="min-w-0"
                                    :data-testid="`settings-usage-composition-token-${slice.key}`"
                                >
                                    <div class="flex items-baseline gap-1.5">
                                        <span
                                            class="h-1.5 w-1.5 shrink-0 rounded-full"
                                            :style="{ backgroundColor: slice.color }"
                                            aria-hidden="true"
                                        />
                                        <span
                                            class="min-w-0 flex-1 truncate text-[11px] text-neutral-600"
                                        >
                                            {{ slice.label }}
                                        </span>
                                        <span
                                            class="shrink-0 text-[11px] text-neutral-900 tabular-nums"
                                        >
                                            {{ formatPercent(slice.ratio) }}
                                        </span>
                                    </div>
                                    <div class="pl-3 text-[10.5px] text-neutral-400 tabular-nums">
                                        {{ slice.detail }}
                                    </div>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>
            </div>
        </section>

        <!-- 耗时构成 -->
        <section class="space-y-3">
            <div class="flex items-baseline justify-between gap-2">
                <h2 class="settings-section-title">
                    {{ t('settings.usage.composition.timingTitle') }}
                </h2>
                <span class="text-[11px] text-neutral-400">
                    {{ t('settings.usage.composition.timingNote') }}
                </span>
            </div>

            <div class="rounded-[11px] bg-neutral-50/80 p-4">
                <div v-if="timingSlices.length === 0" class="py-10 text-center">
                    <span class="text-xs text-neutral-400">
                        {{ t('settings.usage.composition.empty') }}
                    </span>
                </div>

                <div v-else class="flex items-center gap-5">
                    <div class="relative shrink-0">
                        <svg
                            :viewBox="`0 0 96 96`"
                            class="h-[96px] w-[96px] -rotate-90"
                            role="img"
                            :aria-label="t('settings.usage.composition.timingTitle')"
                        >
                            <circle
                                :cx="48"
                                :cy="48"
                                :r="R"
                                fill="none"
                                stroke="currentColor"
                                class="text-neutral-200/70"
                                :stroke-width="STROKE"
                            />
                            <circle
                                v-for="slice in timingSlices"
                                :key="slice.key"
                                :cx="48"
                                :cy="48"
                                :r="R"
                                fill="none"
                                :stroke="slice.color"
                                :stroke-width="STROKE"
                                :stroke-dasharray="slice.dash"
                                :stroke-dashoffset="slice.offset"
                                stroke-linecap="butt"
                            />
                        </svg>
                        <div
                            class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
                        >
                            <span
                                class="font-serif text-[15px] leading-none font-semibold text-neutral-950 tabular-nums"
                            >
                                {{ formatLongDuration(composition.timing.totalMs) }}
                            </span>
                            <span class="mt-0.5 text-[10px] text-neutral-400">
                                {{ t('settings.usage.composition.activeTime') }}
                            </span>
                        </div>
                    </div>

                    <div class="grid min-w-0 flex-1 grid-cols-2 gap-x-5 gap-y-2.5 xl:max-w-[420px]">
                        <template v-for="column in timingColumns" :key="column[0]?.key ?? 'empty'">
                            <div class="min-w-0 space-y-2">
                                <div
                                    v-for="slice in column"
                                    :key="slice.key"
                                    class="min-w-0"
                                    :data-testid="`settings-usage-composition-timing-${slice.key}`"
                                >
                                    <div class="flex items-baseline gap-1.5">
                                        <span
                                            class="h-1.5 w-1.5 shrink-0 rounded-full"
                                            :style="{ backgroundColor: slice.color }"
                                            aria-hidden="true"
                                        />
                                        <span
                                            class="min-w-0 flex-1 truncate text-[11px] text-neutral-600"
                                        >
                                            {{ slice.label }}
                                        </span>
                                        <span
                                            class="shrink-0 text-[11px] text-neutral-900 tabular-nums"
                                        >
                                            {{ formatPercent(slice.ratio) }}
                                        </span>
                                    </div>
                                    <div class="pl-3 text-[10.5px] text-neutral-400 tabular-nums">
                                        {{ slice.detail }}
                                    </div>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>
            </div>
        </section>
    </div>
</template>
