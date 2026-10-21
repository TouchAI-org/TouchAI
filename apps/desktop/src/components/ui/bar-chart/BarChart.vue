<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * 堆叠柱状图。
     *
     * 移植自 uiarc 的 bar-chart，并扩展成堆叠（「分布」需要看构成）：
     * - 柱顶圆角只给最上面一段，基线一侧方角，整根柱读起来是一个整体
     * - 最新的柱固定在右侧，区间变长时向左「拉远」
     * - 虚线是每根柱的合计平均值，随区间变化平滑移动
     * - 悬停整列高亮并给出明细，键盘左右键同样可用
     * - 首帧从基线长出来，逐根错开
     */
    import { computed, onMounted, ref } from 'vue';

    import { columnPath, fittingLabels, niceScale } from './geometry';

    interface Series {
        key: string;
        label: string;
        color?: string;
    }

    interface Datum {
        key: string;
        label: string;
        axisLabel?: string;
        values: Record<string, number>;
    }

    interface Props {
        data: Datum[];
        series: Series[];
        label: string;
        /** 绘图区高度 */
        height?: number;
        formatValue?: (value: number) => string;
        formatTick?: (value: number) => string;
        /** 顶部序列开关 */
        legend?: boolean;
        /** 合计平均值虚线 */
        showAverage?: boolean;
        emptyLabel?: string;
    }

    const props = withDefaults(defineProps<Props>(), {
        height: 200,
        formatValue: (value: number) => String(Math.round(value)),
        formatTick: undefined,
        legend: undefined,
        showAverage: true,
        emptyLabel: undefined,
    });

    defineOptions({ name: 'BarChart' });

    const PALETTE = [
        'rgb(63 63 70)',
        'rgb(14 165 233)',
        'rgb(16 185 129)',
        'rgb(245 158 11)',
        'rgb(139 92 246)',
        'rgb(163 163 163)',
    ];

    function colorOf(series: Series, index: number): string {
        return series.color ?? PALETTE[Math.min(index, PALETTE.length - 1)]!;
    }

    const hidden = ref<string[]>([]);
    const visible = computed(() => props.series.filter((item) => !hidden.value.includes(item.key)));
    const showLegend = computed(() => props.legend ?? props.series.length > 1);

    function toggle(key: string): void {
        hidden.value = hidden.value.includes(key)
            ? hidden.value.filter((item) => item !== key)
            : [...hidden.value, key];
    }

    // ===== 布局 =====

    /** 左侧留给刻度，底部留给轴标签 */
    const PAD = { top: 12, right: 4, bottom: 20, left: 0 };
    const VIEW_WIDTH = 760;
    const GAP = 1.5;
    const MAX_BAR = 26;

    const plotHeight = computed(() => props.height - PAD.top - PAD.bottom);

    /** 每根柱的合计，用于定纵轴与平均值 */
    const totals = computed(() =>
        props.data.map((item) =>
            visible.value.reduce((sum, line) => sum + (item.values[line.key] ?? 0), 0)
        )
    );

    const scale = computed(() => niceScale(Math.max(0, ...totals.value)));
    const max = computed(() => scale.value.max);
    const tickValues = computed(() => scale.value.ticks);

    const average = computed(() => {
        if (totals.value.length === 0) return 0;
        return totals.value.reduce((sum, value) => sum + value, 0) / totals.value.length;
    });

    /** 柱宽：按列数均分，但不超过上限，避免两三天时柱子变成色块 */
    const slot = computed(() => VIEW_WIDTH / Math.max(1, props.data.length));
    const barWidth = computed(() => Math.min(MAX_BAR, slot.value * 0.62));

    function yOf(value: number): number {
        return plotHeight.value - (value / max.value) * plotHeight.value;
    }

    /**
     * 每根柱的分段路径。
     *
     * `progress` 是生长进度（0–1），首帧动画与区间切换都靠它，
     * 这样不必给每根柱各跑一个动画。
     */
    const columns = computed(() =>
        props.data.map((item, index) => {
            const center = slot.value * (index + 0.5);
            const x = center - barWidth.value / 2;

            let cursor = 0;
            const segments = visible.value
                .map((line) => {
                    const value = item.values[line.key] ?? 0;
                    if (value <= 0) return null;
                    const bottom = cursor;
                    cursor += value;
                    // 段高减掉缝，让堆叠关系看得出来
                    const height = Math.max(0, (value / max.value) * plotHeight.value - GAP);
                    return {
                        key: `${item.key}-${line.key}`,
                        color: colorOf(line, props.series.indexOf(line)),
                        top: yOf(cursor),
                        height,
                        bottom,
                        value,
                    };
                })
                .filter((segment): segment is NonNullable<typeof segment> => segment !== null);

            // 只有最上面那段带圆角，其余是方角，整根柱读起来是一个整体
            const topIndex = segments.length - 1;
            const paths = segments.map((segment, order) =>
                columnPath(x, barWidth.value, segment.top, segment.height, order === topIndex)
            );

            return { key: item.key, x, center, segments, paths };
        })
    );

    // ===== 生长动画 =====

    /** 0 → 1：整体从基线长出来 */
    const grown = ref(false);

    onMounted(() => {
        // 等一帧再打开，避免首帧就带着过渡从 0 开始
        requestAnimationFrame(() => {
            grown.value = true;
        });
    });

    /** 每根柱的入场延迟：从左到右错开，最多 240ms */
    function delayOf(index: number): string {
        return `${Math.min(index * 14, 240)}ms`;
    }

    // ===== 交互 =====

    const activeIndex = ref<number | null>(null);
    const plotRef = ref<HTMLElement | null>(null);

    function indexFromClientX(clientX: number): number | null {
        const el = plotRef.value;
        if (!el || props.data.length === 0) return null;
        const rect = el.getBoundingClientRect();
        const ratio = (clientX - rect.left) / rect.width;
        const index = Math.floor(ratio * props.data.length);
        return Math.max(0, Math.min(props.data.length - 1, index));
    }

    function onPointerMove(event: PointerEvent): void {
        activeIndex.value = indexFromClientX(event.clientX);
    }

    function onPointerLeave(): void {
        activeIndex.value = null;
    }

    function onKeydown(event: KeyboardEvent): void {
        if (props.data.length === 0) return;
        const current = activeIndex.value ?? props.data.length - 1;
        if (event.key === 'ArrowLeft') {
            activeIndex.value = Math.max(0, current - 1);
            event.preventDefault();
        } else if (event.key === 'ArrowRight') {
            activeIndex.value = Math.min(props.data.length - 1, current + 1);
            event.preventDefault();
        } else if (event.key === 'Escape') {
            activeIndex.value = null;
        }
    }

    const activeDatum = computed(() =>
        activeIndex.value === null ? null : (props.data[activeIndex.value] ?? null)
    );

    /** 标题读数：悬停时给当列合计，静止时给平均值 */
    const tooltipStyle = computed(() => {
        if (activeIndex.value === null || props.data.length === 0) return {};
        const ratio = (activeIndex.value + 0.5) / props.data.length;
        // 靠右时改为向左展开，避免贴边被裁掉
        return ratio > 0.62
            ? { right: `${(1 - ratio) * 100}%`, marginRight: '8px' }
            : { left: `${ratio * 100}%`, marginLeft: '8px' };
    });

    const labelIndexes = computed(() => fittingLabels(props.data.length, VIEW_WIDTH));

    function axisLabelOf(datum: Datum): string {
        return datum.axisLabel ?? datum.label;
    }

    const formatTick = computed(() => props.formatTick ?? props.formatValue);
</script>

<template>
    <figure class="m-0 min-w-0">
        <div v-if="showLegend" class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <button
                v-for="(line, index) in series"
                :key="line.key"
                type="button"
                class="flex items-center gap-1.5 text-[11px] transition-opacity"
                :class="hidden.includes(line.key) ? 'opacity-40' : 'opacity-100'"
                :aria-pressed="!hidden.includes(line.key)"
                @click="toggle(line.key)"
            >
                <span
                    class="h-2 w-2 shrink-0 rounded-full"
                    :style="{ backgroundColor: colorOf(line, index) }"
                    aria-hidden="true"
                />
                <span class="max-w-40 truncate text-neutral-600">{{ line.label }}</span>
            </button>
        </div>

        <div
            v-if="data.length === 0"
            class="flex items-center justify-center"
            :style="{ height: `${height}px` }"
        >
            <span class="text-xs text-neutral-400">{{ emptyLabel }}</span>
        </div>

        <div v-else class="relative flex gap-2">
            <!-- 纵轴刻度放在图外，与折线图、构成环一致 -->
            <div
                class="flex w-9 shrink-0 flex-col justify-between text-right text-[9px] text-neutral-400 tabular-nums"
                :style="{
                    height: `${height}px`,
                    paddingTop: `${PAD.top}px`,
                    paddingBottom: `${PAD.bottom}px`,
                }"
                aria-hidden="true"
            >
                <span v-for="(tick, index) in [...tickValues].reverse()" :key="index">
                    {{ formatTick(tick) }}
                </span>
            </div>

            <div
                ref="plotRef"
                class="min-w-0 flex-1 outline-none"
                tabindex="0"
                role="application"
                :aria-label="label"
                @pointermove="onPointerMove"
                @pointerleave="onPointerLeave"
                @keydown="onKeydown"
            >
                <svg
                    :viewBox="`0 0 ${VIEW_WIDTH} ${height}`"
                    :height="height"
                    class="block w-full overflow-visible"
                    role="img"
                    :aria-label="label"
                >
                    <g :transform="`translate(0, ${PAD.top})`">
                        <!-- 网格线 -->
                        <line
                            v-for="tick in tickValues"
                            :key="`grid-${tick}`"
                            x1="0"
                            :x2="VIEW_WIDTH"
                            :y1="yOf(tick)"
                            :y2="yOf(tick)"
                            stroke="currentColor"
                            class="text-neutral-200/60"
                            stroke-width="1"
                        />

                        <!-- 悬停列底纹 -->
                        <rect
                            v-if="activeIndex !== null"
                            :x="activeIndex * slot"
                            y="0"
                            :width="slot"
                            :height="plotHeight"
                            fill="currentColor"
                            class="text-neutral-900/[0.035]"
                            rx="4"
                        />

                        <!-- 柱：从基线长出来，逐根错开 -->
                        <g
                            v-for="(column, index) in columns"
                            :key="column.key"
                            :style="{
                                transformOrigin: `0px ${plotHeight}px`,
                                transform: grown ? 'scaleY(1)' : 'scaleY(0)',
                                transition: `transform 620ms cubic-bezier(.22,.61,.36,1) ${delayOf(index)}`,
                            }"
                        >
                            <path
                                v-for="(segment, order) in column.segments"
                                :key="segment.key"
                                :d="column.paths[order]"
                                :fill="segment.color"
                            />
                        </g>

                        <!-- 平均值虚线 -->
                        <g v-if="showAverage && average > 0">
                            <line
                                x1="0"
                                :x2="VIEW_WIDTH"
                                :y1="yOf(average)"
                                :y2="yOf(average)"
                                stroke="currentColor"
                                class="text-neutral-400"
                                stroke-width="1"
                                stroke-dasharray="3 3"
                            />
                            <text
                                :x="VIEW_WIDTH - 2"
                                :y="yOf(average) - 4"
                                text-anchor="end"
                                class="fill-neutral-400"
                                font-size="9"
                            >
                                {{ formatTick(average) }}
                            </text>
                        </g>

                        <!-- 基线 -->
                        <line
                            x1="0"
                            :x2="VIEW_WIDTH"
                            :y1="plotHeight"
                            :y2="plotHeight"
                            stroke="currentColor"
                            class="text-neutral-300"
                            stroke-width="1"
                        />

                        <!-- 轴标签 -->
                        <text
                            v-for="index in labelIndexes"
                            :key="`x-${index}`"
                            :x="slot * (index + 0.5)"
                            :y="height - PAD.top - 6"
                            text-anchor="middle"
                            class="fill-neutral-400"
                            font-size="9"
                        >
                            {{ axisLabelOf(data[index]!) }}
                        </text>
                    </g>
                </svg>
            </div>

            <!-- tooltip：悬停列的明细 -->
            <div
                v-if="activeDatum"
                class="pointer-events-none absolute top-0 z-10 min-w-36 rounded-[10px] border border-neutral-200 bg-white px-3 py-2 text-xs shadow-sm"
                :style="tooltipStyle"
                data-testid="bar-chart-tooltip"
            >
                <div class="mb-1 text-[11px] font-medium text-neutral-900">
                    {{ activeDatum.label }}
                </div>
                <div class="space-y-0.5">
                    <div v-for="line in visible" :key="line.key" class="flex items-center gap-2">
                        <span
                            class="h-2 w-2 shrink-0 rounded-full"
                            :style="{ backgroundColor: colorOf(line, series.indexOf(line)) }"
                            aria-hidden="true"
                        />
                        <span class="min-w-0 flex-1 truncate text-neutral-600">
                            {{ line.label }}
                        </span>
                        <span class="shrink-0 text-neutral-900 tabular-nums">
                            {{ formatValue(activeDatum.values[line.key] ?? 0) }}
                        </span>
                    </div>
                </div>
                <div
                    v-if="visible.length > 1"
                    class="mt-1 flex items-center justify-between gap-2 border-t border-neutral-100 pt-1 text-[11px]"
                >
                    <span class="text-neutral-400">合计</span>
                    <span class="text-neutral-900 tabular-nums">
                        {{ formatValue(activeIndex === null ? 0 : (totals[activeIndex] ?? 0)) }}
                    </span>
                </div>
            </div>
        </div>
    </figure>
</template>
