<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * Donut chart.
     *
     * Ported from uiarc's donut-chart (React + motion upstream), keeping its
     * core mechanics:
     * - Rounded annular sectors with a constant pixel gap, so segments separate
     *   without relying on stroke-dasharray.
     * - Colour follows the key, so an item keeps its colour across data changes.
     * - Hovering the legend or a sector lights both up; the rest dim and lift.
     * - The centre readout shows the active slice, or the total when idle.
     * - Slices below the threshold merge into "other".
     *
     * Animation writes the `d` attribute per frame: a CSS transition on an SVG
     * path desynchronises when shapes differ a lot, while per-frame writes keep
     * every slice in lockstep.
     */
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import { groupSlices, layout, sector } from './geometry';

    interface Props {
        data: Array<{ key: string; label: string; value: number; color?: string }>;
        /** Centre caption; replaced by the slice name when one is active. */
        totalLabel?: string;
        /** Ring diameter in px. */
        size?: number;
        /** Ring thickness. */
        thickness?: number;
        /** Slices below this share merge into "other". */
        groupBelow?: number;
        /** Maximum kept slices, excluding "other". */
        maxSegments?: number;
        /** Value formatter. */
        formatValue?: (value: number) => string;
        /** Keys whose values are estimated; their legend label gets a ≈ prefix. */
        estimatedKeys?: string[];
        /** Whether to render the legend. */
        legend?: boolean;
        emptyLabel?: string;
    }

    const props = withDefaults(defineProps<Props>(), {
        totalLabel: undefined,
        size: 160,
        thickness: 20,
        groupBelow: 0.04,
        maxSegments: 6,
        formatValue: (value: number) => String(Math.round(value)),
        estimatedKeys: () => [],
        legend: true,
        emptyLabel: undefined,
    });

    defineOptions({ name: 'DonutChart' });

    /** Segment gap and corner radius, in px. */
    const GAP = 3;
    const CORNER = 5;
    /** How far a hovered slice lifts outward. */
    const GROW = 2;

    /**
     * Shared palette with the trend chart and composition rings.
     *
     * CSS variables rather than literal colours, so a dark theme follows
     * automatically.
     */
    const SERIES = [
        'var(--usage-series-1, rgb(63 63 70))',
        'var(--usage-series-2, rgb(14 165 233))',
        'var(--usage-series-3, rgb(16 185 129))',
        'var(--usage-series-4, rgb(245 158 11))',
        'var(--usage-series-5, rgb(139 92 246))',
        'var(--usage-series-6, rgb(236 72 153))',
    ];
    const OTHER_KEY = '__other';
    const OTHER_COLOR = 'rgb(212 212 212)';

    const slices = computed(() =>
        groupSlices(
            props.data,
            props.groupBelow,
            props.maxSegments,
            t('settings.usage.chart.other'),
            OTHER_KEY
        )
    );

    /**
     * Colours are assigned by first appearance of a key.
     *
     * Assigning by array index would recolour an item whenever a filter changes
     * the ordering, which reads as a different item entirely.
     */
    const palette = ref(new Map<string, number>());
    watch(
        () => props.data.map((item) => item.key),
        (keys) => {
            const next = new Map(palette.value);
            for (const key of keys) if (!next.has(key)) next.set(key, next.size);
            palette.value = next;
        },
        { immediate: true }
    );

    function colorOf(item: { key: string; color?: string }): string {
        if (item.color) return item.color;
        if (item.key === OTHER_KEY) return OTHER_COLOR;
        const index = palette.value.get(item.key) ?? 0;
        return SERIES[index % SERIES.length]!;
    }

    const total = computed(() => slices.value.reduce((sum, item) => sum + item.value, 0));

    // ===== Interaction state =====

    /** Legend click pins a slice; clicking it again clears the pin. */
    const selected = ref<string | null>(null);
    /** Hover preview, which outranks the pin. */
    const preview = ref<string | null>(null);

    const activeKey = computed(() => preview.value ?? selected.value);
    const activeSlice = computed(
        () => slices.value.find((item) => item.key === activeKey.value) ?? null
    );

    function toggle(key: string): void {
        selected.value = selected.value === key ? null : key;
    }

    function ratioOf(value: number): number {
        return total.value > 0 ? value / total.value : 0;
    }

    /** Prefix estimated values with ≈ in the legend, matching the card notes. */
    function valueText(key: string, value: number): string {
        const mark = props.estimatedKeys.includes(key) ? '≈' : '';
        return `${mark}${props.formatValue(value)}`;
    }

    // ===== Animation: write the path per frame =====

    const c = computed(() => props.size / 2);
    const outer = computed(() => c.value - 6);
    const inner = computed(() => Math.max(8, outer.value - props.thickness));
    const corner = computed(() => Math.min(CORNER, props.thickness / 4));

    /** Per-slice animation state: arc positions in 0..1, plus the lift amount. */
    interface Anim {
        start: number;
        end: number;
        lift: number;
        targetStart: number;
        targetEnd: number;
        targetLift: number;
        velocityStart: number;
        velocityEnd: number;
        velocityLift: number;
    }

    const anims = new Map<string, Anim>();
    /** Path element of each slice. */
    const pathRefs = new Map<string, SVGPathElement>();

    const rendered = ref<Array<{ key: string; d: string; color: string; dim: boolean }>>([]);

    function setPathRef(key: string) {
        return (el: unknown) => {
            // jsdom has no SVGPathElement constructor, so check tagName instead.
            const isPath =
                typeof el === 'object' &&
                el !== null &&
                (el as { tagName?: string }).tagName?.toLowerCase() === 'path';
            if (isPath) pathRefs.set(key, el as SVGPathElement);
            else pathRefs.delete(key);
        };
    }

    /**
     * Numerical integration of a critically damped spring.
     *
     * More natural than linear easing: slice edges chase the target instead of
     * sliding at constant speed. A fixed step plus a convergence check stops the
     * rAF loop once settled, so it costs nothing at rest.
     */
    const STIFFNESS = 170;
    const DAMPING = 26;
    const REST = 0.0005;

    function step(anim: Anim, dt: number): boolean {
        let moving = false;
        const integrate = (
            value: number,
            target: number,
            velocity: number,
            set: (v: number, vel: number) => void
        ) => {
            const force = (target - value) * STIFFNESS - velocity * DAMPING;
            const nextVelocity = velocity + force * dt;
            const nextValue = value + nextVelocity * dt;
            const settled =
                Math.abs(target - nextValue) < REST && Math.abs(nextVelocity) < REST * 2;
            set(settled ? target : nextValue, settled ? 0 : nextVelocity);
            if (!settled) moving = true;
        };

        integrate(anim.start, anim.targetStart, anim.velocityStart, (v, vel) => {
            anim.start = v;
            anim.velocityStart = vel;
        });
        integrate(anim.end, anim.targetEnd, anim.velocityEnd, (v, vel) => {
            anim.end = v;
            anim.velocityEnd = vel;
        });
        integrate(anim.lift, anim.targetLift, anim.velocityLift, (v, vel) => {
            anim.lift = v;
            anim.velocityLift = vel;
        });
        return moving;
    }

    let raf = 0;
    let lastTime = 0;

    function paint(): void {
        const list: Array<{ key: string; d: string; color: string; dim: boolean }> = [];
        const active = activeKey.value;

        for (const item of slices.value) {
            const anim = anims.get(item.key);
            if (!anim) continue;
            const R = outer.value + anim.lift * GROW;
            const r = inner.value - anim.lift * GROW * 0.5;
            const d = sector(c.value, R, r, anim.start, anim.end, GAP, corner.value);
            list.push({
                key: item.key,
                d,
                color: colorOf(item),
                dim: active !== null && active !== item.key,
            });
        }
        rendered.value = list;
    }

    function tick(time: number): void {
        const dt = lastTime === 0 ? 1 / 60 : Math.min(0.05, (time - lastTime) / 1000);
        lastTime = time;

        let moving = false;
        for (const anim of anims.values()) {
            if (step(anim, dt)) moving = true;
        }
        paint();

        if (moving) raf = requestAnimationFrame(tick);
        else raf = 0;
    }

    function ensureFrame(): void {
        if (raf === 0) {
            lastTime = 0;
            raf = requestAnimationFrame(tick);
        }
    }

    /** Retarget every slice and start the loop when data or selection changes. */
    function retarget(): void {
        const arcs = layout(slices.value, new Set<string>());
        const active = activeKey.value;

        // A new slice grows out of the previous slice's current edge instead of
        // popping in from zero.
        const order = slices.value.map((item) => item.key);
        order.forEach((key, index) => {
            const arc = arcs.get(key) ?? { start: 0, end: 0 };
            let anim = anims.get(key);
            if (!anim) {
                const prior = order
                    .slice(0, index)
                    .reverse()
                    .map((k) => anims.get(k))
                    .find(Boolean);
                const from = prior ? prior.end : 0;
                anim = {
                    start: from,
                    end: from,
                    lift: 0,
                    targetStart: arc.start,
                    targetEnd: arc.end,
                    targetLift: 0,
                    velocityStart: 0,
                    velocityEnd: 0,
                    velocityLift: 0,
                };
                anims.set(key, anim);
            }
            anim.targetStart = arc.start;
            anim.targetEnd = arc.end;
            anim.targetLift = active === key ? 1 : 0;
        });

        // Removed slices collapse to zero width and drop out once settled.
        for (const [key, anim] of anims) {
            if (!order.includes(key)) {
                anim.targetStart = anim.end;
                anim.targetEnd = anim.end;
                anim.targetLift = 0;
            }
        }

        ensureFrame();
    }

    watch([slices, activeKey], () => retarget(), { deep: true, immediate: true });

    onMounted(() => {
        // First mount: every slice sweeps out from twelve o'clock together.
        for (const anim of anims.values()) {
            anim.start = 0;
            anim.end = 0;
        }
        retarget();
    });

    onBeforeUnmount(() => {
        if (raf !== 0) cancelAnimationFrame(raf);
        raf = 0;
        anims.clear();
        pathRefs.clear();
    });

    /** Centre readout: the active slice, or the total when idle. */
    const centerValue = computed(() =>
        props.formatValue(activeSlice.value ? activeSlice.value.value : total.value)
    );
    const centerLabel = computed(() =>
        activeSlice.value ? activeSlice.value.label : (props.totalLabel ?? '')
    );
    const centerMeta = computed(() => {
        if (!activeSlice.value) return '';
        return `${(ratioOf(activeSlice.value.value) * 100).toFixed(1)}%`;
    });

    /**
     * Centre font size.
     *
     * Start from a size derived from the ring, then shrink to fit the actual
     * string width so a long readout like `148.6万` stays inside the hole
     * instead of being clipped to `148…`.
     */
    const centerFontSize = computed(() => {
        const base = Math.max(12, Math.round(props.size * (centerMeta.value ? 0.085 : 0.1)));
        const text = centerValue.value;
        // Digits and Latin average about 0.58em; CJK counts as 1em.
        const units = [...text].reduce(
            (total, char) => total + (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.58),
            0
        );
        const available = Math.max(40, inner.value * 2 - 14);
        const fit = units > 0 ? available / units : base;
        return Math.max(10, Math.round(Math.min(base, fit)));
    });
</script>

<template>
    <figure
        class="grid min-w-0 grid-cols-1 items-center gap-6"
        :class="legend ? 'sm:grid-cols-[auto_minmax(0,1fr)]' : ''"
    >
        <div
            class="relative justify-self-center"
            :style="{ width: `${size}px`, height: `${size}px` }"
        >
            <svg
                :viewBox="`0 0 ${size} ${size}`"
                class="block h-full w-full overflow-visible"
                role="img"
                :aria-label="totalLabel ?? ''"
            >
                <!-- 底环：无数据时显示，让空态也有形状 -->
                <circle
                    v-if="rendered.length === 0"
                    :cx="c"
                    :cy="c"
                    :r="(outer + inner) / 2"
                    fill="none"
                    stroke="currentColor"
                    class="text-neutral-200/70"
                    :stroke-width="thickness"
                />
                <path
                    v-for="item in rendered"
                    :key="item.key"
                    :ref="setPathRef(item.key)"
                    :d="item.d"
                    :fill="item.color"
                    :opacity="item.dim ? 0.45 : 1"
                    class="transition-opacity duration-200"
                    style="shape-rendering: geometricPrecision"
                    @mouseenter="preview = item.key"
                    @mouseleave="preview = null"
                />
            </svg>

            <!-- 中心读数：用 grid 叠放，切换时不移动也不改变尺寸 -->
            <!-- inner 是半径，中心框宽度要按直径算，否则读数会被截断 -->
            <div
                class="pointer-events-none absolute top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 text-center"
                :style="{ width: `${Math.max(40, inner * 2 - 10)}px` }"
            >
                <span
                    class="block w-full font-serif leading-tight font-semibold whitespace-nowrap text-neutral-950 tabular-nums"
                    :style="{
                        fontSize: `${centerFontSize}px`,
                    }"
                >
                    {{ centerValue }}
                </span>
                <span
                    v-if="centerLabel"
                    class="mt-1 block w-full truncate text-[10px] leading-4 text-neutral-400"
                >
                    {{ centerLabel }}
                </span>
                <span
                    v-if="centerMeta"
                    class="block w-full truncate text-[10px] leading-4 text-neutral-400 tabular-nums"
                >
                    {{ centerMeta }}
                </span>
            </div>
        </div>

        <ul v-if="legend" class="m-0 min-w-0 list-none p-0">
            <li v-for="item in slices" :key="item.key">
                <button
                    type="button"
                    class="flex w-full min-w-0 items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left transition-colors"
                    :class="
                        activeKey === item.key
                            ? 'bg-neutral-900/[0.05]'
                            : 'hover:bg-neutral-900/[0.04]'
                    "
                    :aria-pressed="selected === item.key"
                    @click="toggle(item.key)"
                    @mouseenter="preview = item.key"
                    @mouseleave="preview = null"
                >
                    <span
                        class="h-2 w-2 shrink-0 rounded-full"
                        :style="{ backgroundColor: colorOf(item) }"
                        aria-hidden="true"
                    />
                    <span
                        class="min-w-0 flex-1 truncate text-[12px] text-neutral-700"
                        :title="item.label"
                    >
                        {{ item.label }}
                    </span>
                    <span class="shrink-0 text-[11px] text-neutral-400 tabular-nums">
                        {{ valueText(item.key, item.value) }}
                    </span>
                    <span
                        class="w-11 shrink-0 text-right text-[12px] font-medium text-neutral-900 tabular-nums"
                    >
                        {{ (ratioOf(item.value) * 100).toFixed(1) }}%
                    </span>
                </button>
            </li>
        </ul>
    </figure>
</template>
