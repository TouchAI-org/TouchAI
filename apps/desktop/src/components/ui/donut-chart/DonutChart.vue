<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * 环形图。
     *
     * 移植自 uiarc 的 donut-chart（原版是 React + motion），保留它的核心机制：
     * - 圆角环形扇形 + 恒定像素间隙（不用 stroke-dasharray，段之间才有空隙）
     * - 颜色跟着 key 走，切换数据集时同一项不变色
     * - 悬停图例或扇区时两边同时点亮，其余变暗并向外抬起
     * - 中心读数在有选中项时显示该项，静止时显示总量
     * - 占比过小的段自动合并为「其他」
     *
     * 动画用 requestAnimationFrame 直接写 `d` 属性：SVG path 的 CSS 过渡
     * 在形状差异大时会错位，逐帧写入才能让所有段严格同步。
     */
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import { groupSlices, layout, sector } from './geometry';

    interface Props {
        data: Array<{ key: string; label: string; value: number; color?: string }>;
        /** 中心副标题；选中时替换为该项名称 */
        totalLabel?: string;
        /** 环直径（px） */
        size?: number;
        /** 环的粗细 */
        thickness?: number;
        /** 低于此占比的段并入「其他」 */
        groupBelow?: number;
        /** 最多保留多少段（不含「其他」） */
        maxSegments?: number;
        /** 数值格式化 */
        formatValue?: (value: number) => string;
        /** 这些 key 的值是估算的，图例里带 ≈ 前缀 */
        estimatedKeys?: string[];
        /** 是否显示右侧图例 */
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

    /** 段间隙与圆角（px） */
    const GAP = 3;
    const CORNER = 5;
    /** 悬停时向外抬起的距离 */
    const GROW = 2;

    /**
     * 与趋势图、构成环共用同一套色板。
     *
     * 用 CSS 变量而不是硬编码色值，暗色主题下自动跟随。
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
     * 颜色按 key 首次出现的顺序分配。
     *
     * 如果按数组下标分配，筛选变化导致排序变动时同一项会突然换色，
     * 读者会以为换成了另一个东西。
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

    // ===== 交互状态 =====

    /** 图例点选：固定某一项（再点一次取消） */
    const selected = ref<string | null>(null);
    /** 悬停预览：优先级高于选中 */
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

    /** 估算值的图例数字前加 ≈，与卡片上的说明一致 */
    function valueText(key: string, value: number): string {
        const mark = props.estimatedKeys.includes(key) ? '≈' : '';
        return `${mark}${props.formatValue(value)}`;
    }

    // ===== 动画：逐帧写入 path =====

    const c = computed(() => props.size / 2);
    const outer = computed(() => c.value - 6);
    const inner = computed(() => Math.max(8, outer.value - props.thickness));
    const corner = computed(() => Math.min(CORNER, props.thickness / 4));

    /** 每段当前的动画状态：start/end 是 0–1 的弧位置，lift 是抬起量 */
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
    /** 每段的 path 元素 */
    const pathRefs = new Map<string, SVGPathElement>();

    const rendered = ref<Array<{ key: string; d: string; color: string; dim: boolean }>>([]);

    function setPathRef(key: string) {
        return (el: unknown) => {
            // jsdom 里没有 SVGPathElement 构造函数，用 tagName 判断更稳
            const isPath =
                typeof el === 'object' &&
                el !== null &&
                (el as { tagName?: string }).tagName?.toLowerCase() === 'path';
            if (isPath) pathRefs.set(key, el as SVGPathElement);
            else pathRefs.delete(key);
        };
    }

    /**
     * 临界阻尼弹簧的数值积分。
     *
     * 比线性缓动自然：数据更新时段的边会「追」过去而不是匀速滑过去。
     * 用固定步长 + 收敛判定，静止后停止 rAF，避免常驻耗电。
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

    /** 数据或选中态变化时，重设目标并启动动画 */
    function retarget(): void {
        const arcs = layout(slices.value, new Set<string>());
        const active = activeKey.value;

        // 新出现的段从前一段的当前位置长出来，不会从 0 突然冒出
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

        // 已经不存在的段：目标收成 0，动画结束后移除
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
        // 首次进入：所有段从 12 点一起扫开
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

    /** 中心读数：选中时显示该项，静止时显示总量 */
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
     * 中心读数的字号。
     *
     * 先按环大小给一个基准字号，再根据字符串实际占宽收缩，
     * 保证「148.6万」这类长读数完整落在孔洞里，而不是被截成「148…」。
     */
    const centerFontSize = computed(() => {
        const base = Math.max(12, Math.round(props.size * (centerMeta.value ? 0.085 : 0.1)));
        const text = centerValue.value;
        // 数字与西文约 0.58em，中日韩字符按 1em 计
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
                    <span class="min-w-0 flex-1 truncate text-[12px] text-neutral-700">
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
