<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * 折线 / 面积图。
     *
     * 移植自 uiarc 的 line-chart，保留它的关键机制：
     * - 单调三次插值：平滑但不会冲出数据范围
     * - 「好看」的刻度：1/2/2.5/5 × 10^n，最多 4 格
     * - 十字准线 + 跟随 tooltip，可用键盘左右移动
     * - 多序列可切换显隐
     * - 刻度值用过渡动画，切换区间时数字滚动而不是瞬变
     */
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import { curveFor, niceScale, toAreaPath, toPath } from './geometry';

    interface Series {
        key: string;
        label: string;
        color?: string;
    }

    interface Datum {
        key: string;
        label: string;
        values: Record<string, number>;
    }

    interface Props {
        data: Datum[];
        series: Series[];
        /** 图表标题，供无障碍读取 */
        label: string;
        /** 绘图区高度 */
        height?: number;
        formatValue?: (value: number, series: Series) => string;
        formatTick?: (value: number) => string;
        /** 是否显示顶部序列开关 */
        legend?: boolean;
        /** 曲线平滑还是直线 */
        curve?: 'smooth' | 'linear';
        /** 空态文案 */
        emptyLabel?: string;
        /** 单位后缀 */
        unit?: string;
    }

    const props = withDefaults(defineProps<Props>(), {
        height: 180,
        formatValue: (value: number) => String(Math.round(value)),
        formatTick: undefined,
        legend: undefined,
        curve: 'smooth',
        emptyLabel: undefined,
        unit: '',
    });

    const emit = defineEmits<{
        (event: 'active-change', index: number | null, datum: Datum | null): void;
    }>();

    defineOptions({ name: 'LineChart' });

    /** 与趋势图、构成环共用同一套色板 */
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

    /** 隐藏的序列：点击顶部开关切换 */
    const hidden = ref<string[]>([]);
    const visible = computed(() => props.series.filter((item) => !hidden.value.includes(item.key)));
    const showLegend = computed(() => props.legend ?? props.series.length > 1);

    function toggle(key: string): void {
        hidden.value = hidden.value.includes(key)
            ? hidden.value.filter((item) => item !== key)
            : [...hidden.value, key];
    }

    // ===== 刻度 =====

    const scale = computed(() => {
        let low = Infinity;
        let high = -Infinity;
        for (const line of visible.value) {
            for (const item of props.data) {
                const value = item.values[line.key] ?? 0;
                low = Math.min(low, value);
                high = Math.max(high, value);
            }
        }
        return Number.isFinite(low) ? niceScale(low, high) : niceScale(0, 100);
    });

    const tickText = computed(() => {
        const format = props.formatTick ?? ((value: number) => String(value));
        return scale.value.ticks.map((value) => format(value));
    });

    // ===== 曲线 =====

    /** 绘图区留白：左侧放刻度，底部放 x 轴标签 */
    const PAD = { top: 10, right: 8, bottom: 22, left: 44 };
    const VIEW_WIDTH = 720;

    const innerWidth = computed(() => VIEW_WIDTH - PAD.left - PAD.right);
    const innerHeight = computed(() => props.height - PAD.top - PAD.bottom);

    const paths = computed(() =>
        visible.value.map((line, index) => {
            const values = props.data.map((item) => item.values[line.key] ?? 0);
            const points = curveFor(values, props.curve === 'smooth');
            return {
                key: line.key,
                color: colorOf(line, props.series.indexOf(line)),
                line: toPath(points, scale.value, innerWidth.value, innerHeight.value),
                area: toAreaPath(points, scale.value, innerWidth.value, innerHeight.value),
                index,
            };
        })
    );

    /** 每条序列的端点，画一个圆点表示最新值 */
    const endPoints = computed(() =>
        visible.value.map((line) => {
            const values = props.data.map((item) => item.values[line.key] ?? 0);
            const lastValue = values[values.length - 1] ?? 0;
            const span = scale.value.max - scale.value.min || 1;
            return {
                key: line.key,
                x: innerWidth.value,
                y: innerHeight.value - ((lastValue - scale.value.min) / span) * innerHeight.value,
            };
        })
    );

    // ===== 十字准线与 tooltip =====

    const activeIndex = ref<number | null>(null);
    const plotRef = ref<HTMLElement | null>(null);

    /** 把鼠标位置换算成最近的数据点下标 */
    function indexFromClientX(clientX: number): number | null {
        const el = plotRef.value;
        if (!el || props.data.length === 0) return null;
        const rect = el.getBoundingClientRect();
        const ratio = (clientX - rect.left) / rect.width;
        const index = Math.round(ratio * (props.data.length - 1));
        return Math.max(0, Math.min(props.data.length - 1, index));
    }

    function onPointerMove(event: PointerEvent): void {
        activeIndex.value = indexFromClientX(event.clientX);
    }

    function onPointerLeave(): void {
        activeIndex.value = null;
    }

    /** 键盘左右移动：让准线在数据点之间跳 */
    function onKeydown(event: KeyboardEvent): void {
        if (props.data.length === 0) return;
        const current = activeIndex.value ?? 0;
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

    watch(activeIndex, (index) => {
        emit('active-change', index, index === null ? null : (props.data[index] ?? null));
    });

    const activeDatum = computed(() =>
        activeIndex.value === null ? null : (props.data[activeIndex.value] ?? null)
    );

    /** 准线的 x 位置（viewBox 坐标） */
    const crosshairX = computed(() => {
        if (activeIndex.value === null || props.data.length < 2) return null;
        const ratio = activeIndex.value / (props.data.length - 1);
        return PAD.left + ratio * innerWidth.value;
    });

    /** tooltip 跟随准线，但不越出容器 */
    const tooltipStyle = computed(() => {
        if (activeIndex.value === null || props.data.length < 2) return {};
        const ratio = activeIndex.value / (props.data.length - 1);
        return { left: `${Math.min(74, Math.max(0, ratio * 100))}%` };
    });

    /** x 轴标签：太密就隔几个显示一个 */
    const xLabels = computed(() => {
        const total = props.data.length;
        if (total === 0) return [];
        const step = total <= 8 ? 1 : Math.ceil(total / 6);
        return props.data
            .map((item, index) => ({ item, index }))
            .filter(({ index }) => index % step === 0)
            .map(({ item, index }) => ({
                key: item.key,
                label: item.label,
                x:
                    PAD.left +
                    (total > 1 ? (index / (total - 1)) * innerWidth.value : innerWidth.value / 2),
            }));
    });

    // ===== 入场动画 =====

    const mounted = ref(false);
    onMounted(() => {
        // 等一帧再打开过渡，避免首帧就带着 transition 从 0 开始
        requestAnimationFrame(() => {
            mounted.value = true;
        });
    });
    onBeforeUnmount(() => {
        mounted.value = false;
    });
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
            <span class="text-xs text-neutral-400">
                {{ emptyLabel ?? t('settings.usage.trend.empty') }}
            </span>
        </div>

        <div v-else class="relative">
            <!-- 纵轴刻度放在图外，与其它图表一致 -->
            <div class="flex gap-2">
                <div
                    class="flex w-9 shrink-0 flex-col justify-between text-right text-[9px] text-neutral-400 tabular-nums"
                    :style="{
                        height: `${height}px`,
                        paddingTop: `${PAD.top}px`,
                        paddingBottom: `${PAD.bottom}px`,
                    }"
                    aria-hidden="true"
                >
                    <span v-for="(text, index) in [...tickText].reverse()" :key="index">
                        {{ text }}
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
                        class="block w-full"
                        role="img"
                        :aria-label="label"
                    >
                        <g :transform="`translate(${PAD.left}, ${PAD.top})`">
                            <!-- 网格线 -->
                            <line
                                v-for="(tick, index) in scale.ticks"
                                :key="`grid-${tick}`"
                                x1="0"
                                :x2="innerWidth"
                                :y1="
                                    innerHeight -
                                    (index / Math.max(1, scale.ticks.length - 1)) * innerHeight
                                "
                                :y2="
                                    innerHeight -
                                    (index / Math.max(1, scale.ticks.length - 1)) * innerHeight
                                "
                                stroke="currentColor"
                                class="text-neutral-200/60"
                                stroke-width="1"
                            />

                            <!-- 面积与折线：同一个 d 来源，天然同步 -->
                            <g
                                v-for="path in paths"
                                :key="path.key"
                                class="transition-opacity duration-300"
                                :style="{ opacity: mounted ? 1 : 0 }"
                            >
                                <path :d="path.area" :fill="path.color" fill-opacity="0.1" />
                                <path
                                    :d="path.line"
                                    fill="none"
                                    :stroke="path.color"
                                    stroke-width="1.6"
                                    stroke-linejoin="round"
                                    stroke-linecap="round"
                                />
                            </g>

                            <circle
                                v-for="point in endPoints"
                                :key="`end-${point.key}`"
                                :cx="point.x"
                                :cy="point.y"
                                r="2.5"
                                :fill="paths.find((p) => p.key === point.key)?.color"
                            />

                            <!-- 十字准线 -->
                            <line
                                v-if="crosshairX !== null"
                                :x1="crosshairX - PAD.left"
                                :x2="crosshairX - PAD.left"
                                y1="0"
                                :y2="innerHeight"
                                stroke="currentColor"
                                class="text-neutral-400"
                                stroke-width="1"
                                stroke-dasharray="2 2"
                            />
                        </g>

                        <!-- x 轴标签 -->
                        <text
                            v-for="tick in xLabels"
                            :key="`x-${tick.key}`"
                            :x="tick.x"
                            :y="height - 6"
                            text-anchor="middle"
                            class="fill-neutral-400"
                            font-size="9"
                        >
                            {{ tick.label }}
                        </text>
                    </svg>
                </div>
            </div>

            <!-- tooltip -->
            <div
                v-if="activeDatum"
                class="pointer-events-none absolute top-0 min-w-36 rounded-[10px] border border-neutral-200 bg-white px-3 py-2 text-xs shadow-sm"
                :style="tooltipStyle"
                data-testid="line-chart-tooltip"
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
                            {{ formatValue(activeDatum.values[line.key] ?? 0, line) }}{{ unit }}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    </figure>
</template>
