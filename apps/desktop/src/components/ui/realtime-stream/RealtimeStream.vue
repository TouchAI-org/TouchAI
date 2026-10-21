<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * 实时流曲线。
     *
     * 参考 uiarc 的 realtime-stream：它的「实时感」不是来自更多数据点，
     * 而是来自三件事，这里都照做：
     * 1. 右边缘永远是「此刻」，时间窗逐帧向前滑，曲线持续向左走；
     * 2. 线头的数值用弹簧跟随最新采样，采样之间的空档也被补成连续曲线；
     * 3. 线头有一个呼吸的实时点，断流时停止呼吸并让窗口停下。
     *
     * 如果只按 500ms 定时重画，画面会一跳一跳，读者一眼就能看出是「刷新」而不是「流」。
     */
    import { niceScale, smoothThrough, toPath } from '@components/ui/line-chart/geometry';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    interface Props {
        /** 采样点：`at` 是时间戳（毫秒），`value` 是速率 */
        points: Array<{ at: number; value: number; anomaly?: string }>;
        label: string;
        unit?: string;
        /** 时间窗长度 */
        windowMs?: number;
        height?: number;
        /** 是否正在流：决定线头是否呼吸、窗口是否继续走 */
        streaming?: boolean;
        formatValue?: (value: number) => string;
        formatTick?: (value: number) => string;
    }

    const props = withDefaults(defineProps<Props>(), {
        unit: '',
        windowMs: 60_000,
        height: 132,
        streaming: false,
        formatValue: (value: number) =>
            value >= 100 ? String(Math.round(value)) : value.toFixed(1),
        formatTick: (value: number) =>
            value >= 100 ? String(Math.round(value)) : value.toFixed(1),
    });

    defineOptions({ name: 'RealtimeStream' });

    // ===== 时间推进 =====

    /** 当前时刻：逐帧推进，窗口才会真的在滑 */
    const now = ref(Date.now());
    let raf = 0;

    function tick(): void {
        now.value = Date.now();
        raf = requestAnimationFrame(tick);
    }

    onMounted(() => {
        raf = requestAnimationFrame(tick);
    });

    onBeforeUnmount(() => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    });

    /**
     * 断流后冻结窗口。
     *
     * 否则对话结束后曲线会一直向左跑，最后只剩一条平线，
     * 用户回来看到的是一片空白，而不是刚才那一段。
     */
    const frozenAt = ref<number | null>(null);
    watch(
        () => props.streaming,
        (streaming) => {
            if (streaming) {
                frozenAt.value = null;
                return;
            }
            frozenAt.value = Date.now();
        }
    );

    const edge = computed(() => frozenAt.value ?? now.value);

    // ===== 线头数值：弹簧跟随 =====

    const STIFFNESS = 150;
    const DAMPING = 24;
    const tip = ref(0);
    let tipVelocity = 0;
    let tipRaf = 0;

    function tipStep(): void {
        const target = props.points[props.points.length - 1]?.value ?? 0;
        const delta = target - tip.value;
        tipVelocity += (STIFFNESS * delta - DAMPING * tipVelocity) * (1 / 60);
        tip.value = Math.max(0, tip.value + tipVelocity * (1 / 60));

        if (Math.abs(delta) < 0.001 && Math.abs(tipVelocity) < 0.001) {
            tip.value = target;
            tipVelocity = 0;
            tipRaf = 0;
            return;
        }
        tipRaf = requestAnimationFrame(tipStep);
    }

    watch(
        () => props.points[props.points.length - 1]?.value,
        () => {
            if (!tipRaf) tipRaf = requestAnimationFrame(tipStep);
        }
    );

    onBeforeUnmount(() => {
        if (tipRaf) cancelAnimationFrame(tipRaf);
        tipRaf = 0;
    });

    // ===== 几何 =====

    const PAD = { top: 8, right: 6, bottom: 4, left: 0 };
    const VIEW_WIDTH = 640;

    const innerWidth = computed(() => VIEW_WIDTH - PAD.left - PAD.right);
    const innerHeight = computed(() => props.height - PAD.top - PAD.bottom);

    /** 窗口内的点，加上右边缘那个「此刻」的虚拟点 */
    const windowed = computed(() => {
        const start = edge.value - props.windowMs;
        const inside = props.points.filter((point) => point.at >= start && point.at <= edge.value);

        // 右边缘补一个点，让线一直连到「此刻」
        const last = inside[inside.length - 1];
        const head = { at: edge.value, value: last ? tip.value : 0, anomaly: undefined };

        return [...inside, head];
    });

    const scale = computed(() => {
        const peak = Math.max(1, ...windowed.value.map((point) => point.value));
        return niceScale(0, peak);
    });

    /** 归一化到 0–1 的 x（按真实时间，而不是下标） */
    const normalized = computed(() => {
        const start = edge.value - props.windowMs;
        const span = props.windowMs || 1;
        return windowed.value.map((point) => (point.at - start) / span);
    });

    const linePath = computed(() => {
        const start = edge.value - props.windowMs;
        const span = props.windowMs || 1;
        const points: Array<[number, number]> = windowed.value.map((point) => [
            Math.min(1, Math.max(0, (point.at - start) / span)),
            point.value,
        ]);
        return toPath(smoothThrough(points), scale.value, innerWidth.value, innerHeight.value);
    });

    const areaPath = computed(() => {
        const line = linePath.value;
        if (!line) return '';
        return `${line} L${innerWidth.value},${innerHeight.value} L0,${innerHeight.value} Z`;
    });

    /** 线头位置 */
    const head = computed(() => {
        const span = scale.value.max - scale.value.min || 1;
        return {
            x: innerWidth.value,
            y: innerHeight.value - ((tip.value - scale.value.min) / span) * innerHeight.value,
        };
    });

    /** 异常点：画一个空心圈 */
    const anomalies = computed(() =>
        windowed.value
            .map((point, index) => ({ point, index }))
            .filter(({ point }) => point.anomaly)
            .map(({ point, index }) => {
                const span = scale.value.max - scale.value.min || 1;
                return {
                    key: `${point.at}-${index}`,
                    x: normalized.value[index]! * innerWidth.value,
                    y:
                        innerHeight.value -
                        ((point.value - scale.value.min) / span) * innerHeight.value,
                    label: point.anomaly!,
                };
            })
    );

    /** 横轴：每秒一个刻度，只标整秒 */
    const xTicks = computed(() => {
        const start = edge.value - props.windowMs;
        const step = props.windowMs / 4;
        return [0, 1, 2, 3, 4].map((index) => {
            const at = new Date(start + index * step);
            return {
                x: (index / 4) * innerWidth.value,
                text: `${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`,
            };
        });
    });

    const tickText = computed(() => [...scale.value.ticks].reverse().map(props.formatTick));

    /** 线头呼吸：只有真的在流时才闪 */
    const pulsing = computed(() => props.streaming);
</script>

<template>
    <div class="flex min-w-0 gap-2">
        <!-- 纵轴刻度放在图外，与其它图表一致 -->
        <div
            class="flex w-9 shrink-0 flex-col justify-between text-right text-[9px] text-neutral-400 tabular-nums"
            :style="{
                height: `${height}px`,
                paddingTop: `${PAD.top}px`,
                paddingBottom: `${PAD.bottom}px`,
            }"
            aria-hidden="true"
        >
            <span v-for="(text, index) in tickText" :key="index">{{ text }}</span>
        </div>

        <div class="min-w-0 flex-1">
            <svg
                :viewBox="`0 0 ${VIEW_WIDTH} ${height}`"
                :height="height"
                class="block w-full overflow-visible"
                role="img"
                :aria-label="label"
            >
                <defs>
                    <linearGradient :id="`rt-fill-${label}`" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="rgb(14 165 233)" stop-opacity="0.22" />
                        <stop offset="100%" stop-color="rgb(14 165 233)" stop-opacity="0" />
                    </linearGradient>
                </defs>

                <g :transform="`translate(${PAD.left}, ${PAD.top})`">
                    <!-- 网格 -->
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

                    <path :d="areaPath" :fill="`url(#rt-fill-${label})`" />
                    <path
                        :d="linePath"
                        fill="none"
                        stroke="rgb(14 165 233)"
                        stroke-width="1.6"
                        stroke-linejoin="round"
                        stroke-linecap="round"
                    />

                    <!-- 异常点 -->
                    <circle
                        v-for="mark in anomalies"
                        :key="mark.key"
                        :cx="mark.x"
                        :cy="mark.y"
                        r="3"
                        fill="white"
                        stroke="rgb(245 158 11)"
                        stroke-width="1.6"
                    >
                        <title>{{ mark.label }}</title>
                    </circle>

                    <!-- 线头：外圈呼吸，内圈实心 -->
                    <circle
                        :cx="head.x"
                        :cy="head.y"
                        r="6"
                        fill="rgb(14 165 233)"
                        :class="pulsing ? 'realtime-pulse' : ''"
                        :opacity="pulsing ? 0.28 : 0"
                    />
                    <circle :cx="head.x" :cy="head.y" r="2.6" fill="rgb(14 165 233)" />
                </g>

                <!-- 横轴时间 -->
                <text
                    v-for="tick in xTicks"
                    :key="tick.text"
                    :x="tick.x + PAD.left"
                    :y="height - 1"
                    text-anchor="middle"
                    class="fill-neutral-400"
                    font-size="9"
                >
                    {{ tick.text }}
                </text>
            </svg>
        </div>
    </div>
</template>

<style scoped>
    /* 线头的呼吸：只有真的在流时才动，断流后静止 */
    .realtime-pulse {
        transform-box: fill-box;
        transform-origin: center;
        animation: realtime-pulse 1.4s ease-out infinite;
    }

    @keyframes realtime-pulse {
        0% {
            transform: scale(0.6);
            opacity: 0.35;
        }
        70% {
            transform: scale(2.2);
            opacity: 0;
        }
        100% {
            transform: scale(2.2);
            opacity: 0;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .realtime-pulse {
            animation: none;
            opacity: 0.2;
        }
    }
</style>
