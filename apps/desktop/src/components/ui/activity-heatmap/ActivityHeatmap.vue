<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * 活动日历热力图。
     *
     * 移植自 uiarc 的 activity-heatmap：
     * - 周为列、星期为行，周一开头；缺的日子按 0 计
     * - 五档：无 / 1 / 2 / 3 / 4，默认按最忙那天的 25/50/75% 切分
     * - 入场按列波形浮现，而不是整块一起淡入
     * - 一个气泡在格子之间滑动（不是每格一个原生 title）
     * - 图例可悬停预览、点击固定，并说明这一档有多少天
     * - 方向键按天/周移动，Home / End 到首尾
     */
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

    import { getLocale, t } from '@/i18n';

    import { type ActivityDay, buildModel, moveIndex, slotOf, toIso, toUtc } from './model';

    interface Props {
        days: ActivityDay[];
        label: string;
        /** 固定的一年窗口：`true` 时右端对齐到本周，左侧补齐整年 */
        yearWindow?: boolean;
        /** 绘图区高度（不含月份与图例） */
        height?: number;
        weekStartsOn?: 0 | 1;
        /** 每格的单位名，用于气泡与图例 */
        unit?: { one: string; other: string };
        formatValue?: (value: number) => string;
        formatDate?: (date: Date) => string;
        /** 悬停格的附加说明（如 token 数与成本） */
        detailOf?: (date: string) => string | null;
    }

    const props = withDefaults(defineProps<Props>(), {
        yearWindow: false,
        height: 150,
        weekStartsOn: 1,
        unit: () => ({ one: 'call', other: 'calls' }),
        formatValue: (value: number) => String(value),
        formatDate: undefined,
        detailOf: undefined,
    });

    defineOptions({ name: 'ActivityHeatmap' });

    const CELL = 12;
    const STEP = 15;
    const GUTTER = 26;
    const HEADER = 16;
    const WAVE = 520;

    /**
     * 补齐到固定一年窗口。
     *
     * 查询只返回有数据的日子，直接用它建模型的话，热力图的跨度会
     * 跟着数据走——第一笔用量到今天，而不是「最近一年」。
     */
    const days = computed<ActivityDay[]>(() => {
        if (!props.yearWindow) return props.days;

        const byDate = new Map(props.days.map((day) => [day.date, day.count]));
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const end = new Date(today);
        // 对齐到本周最后一天，最后一行才完整
        const tail = (7 - ((end.getDay() - props.weekStartsOn + 7) % 7) - 1) % 7;
        end.setDate(end.getDate() + tail);

        const start = new Date(end);
        start.setDate(start.getDate() - 364);

        const filled: ActivityDay[] = [];
        for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
            const key = [
                cursor.getFullYear(),
                String(cursor.getMonth() + 1).padStart(2, '0'),
                String(cursor.getDate()).padStart(2, '0'),
            ].join('-');
            filled.push({ date: key, count: byDate.get(key) ?? 0 });
        }
        return filled;
    });

    const locale = computed(() => getLocale());
    const monthName = computed(() => {
        const formatter = new Intl.DateTimeFormat(locale.value, {
            month: 'short',
            timeZone: 'UTC',
        });
        return (date: Date) => formatter.format(date);
    });

    const model = computed(() =>
        buildModel(days.value, props.weekStartsOn, undefined, monthName.value)
    );

    const naturalWidth = computed(() => GUTTER + model.value.weeks * STEP);
    const naturalHeight = computed(() => HEADER + 7 * STEP);

    /** 格子放大：容器够宽就整体放大，最多 1.5 倍 */
    const containerRef = ref<HTMLElement | null>(null);
    const containerWidth = ref(0);
    const renderWidth = computed(() => {
        if (containerWidth.value <= 0) return naturalWidth.value;
        return Math.min(naturalWidth.value * 1.5, containerWidth.value - 2);
    });
    const scale = computed(() => renderWidth.value / naturalWidth.value);
    const renderHeight = computed(() => naturalHeight.value * scale.value);

    // ===== 入场：按列波形 =====

    const revealed = ref(false);
    let timer = 0;
    let observer: ResizeObserver | null = null;

    onMounted(() => {
        const el = containerRef.value;
        if (el) {
            containerWidth.value = el.clientWidth;
            observer = new ResizeObserver((entries) => {
                const next = entries[0]?.contentRect.width ?? 0;
                if (next > 0) containerWidth.value = next;
            });
            observer.observe(el);
        }

        const reduced =
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) {
            revealed.value = true;
            return;
        }
        requestAnimationFrame(() => {
            revealed.value = true;
        });
        timer = window.setTimeout(() => {
            revealed.value = true;
        }, WAVE + 700);
    });

    onBeforeUnmount(() => {
        observer?.disconnect();
        observer = null;
        window.clearTimeout(timer);
        window.clearTimeout(hideTimer);
    });

    /** 每格的过渡延迟：按列递增，形成从左到右的波 */
    function delayOf(column: number): string {
        return `${Math.min(column * 10, WAVE)}ms`;
    }

    // ===== 图例：悬停预览、点击固定 =====

    const preview = ref<number | null>(null);
    const pinned = ref<number | null>(null);
    const highlight = computed(() => preview.value ?? pinned.value);

    let hideTimer = 0;
    function previewLevel(level: number | null): void {
        window.clearTimeout(hideTimer);
        if (level !== null) {
            preview.value = level;
        } else {
            hideTimer = window.setTimeout(() => {
                preview.value = null;
            }, 90);
        }
    }

    function pinLevel(level: number): void {
        pinned.value = pinned.value === level ? null : level;
    }

    /** 每档的天数，图例里用来说明 */
    const levelDays = computed(() => model.value.perLevel);

    // ===== 气泡 =====

    const focusIndex = ref<number | null>(null);

    const activeIndex = computed(() => focusIndex.value);

    const activeCell = computed(() => {
        const index = activeIndex.value;
        if (index === null) return null;
        const date = toIso(model.value.start + index * 86_400_000);
        return {
            index,
            date,
            count: model.value.counts[index] ?? 0,
            level: model.value.levels[index] ?? 0,
            ...slotOf(model.value, index),
        };
    });

    const bubbleStyle = computed(() => {
        const cell = activeCell.value;
        if (!cell) return {};
        const x = (GUTTER + cell.column * STEP + CELL / 2) * scale.value;
        const y = (HEADER + cell.row * STEP) * scale.value;
        const flip = x > renderWidth.value * 0.7;
        return {
            left: `${x}px`,
            top: `${y}px`,
            transform: `translate(${flip ? '-100%' : '0'}, -100%) translate(${flip ? '-6px' : '6px'}, -8px)`,
        };
    });

    /** 日期文案：优先用调用方给的格式化器 */
    function dateText(iso: string): string {
        const date = new Date(toUtc(iso));
        if (props.formatDate) return props.formatDate(date);
        return new Intl.DateTimeFormat(locale.value, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(date);
    }

    const unitText = computed(() =>
        (activeCell.value?.count ?? 0) === 1 ? props.unit.one : props.unit.other
    );

    /** 图例前缀与「天」的文案 */
    const unitLabel = computed(() => t('settings.usage.heatmap.legendUnit'));
    const dayLabel = computed(() => t('settings.usage.heatmap.legendDay'));

    // ===== 键盘 =====

    function onKeydown(event: KeyboardEvent): void {
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
        if (event.key === 'Escape') {
            focusIndex.value = null;
            return;
        }
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const current = focusIndex.value ?? model.value.length - 1;
        focusIndex.value = moveIndex(model.value, current, event.key);
    }

    // ===== 渲染辅助 =====

    const LEVEL_FILL = [
        'fill-neutral-100',
        'fill-neutral-200',
        'fill-neutral-300',
        'fill-neutral-500',
        'fill-neutral-800',
    ];
    const LEVEL_BG = [
        'bg-neutral-100',
        'bg-neutral-200',
        'bg-neutral-300',
        'bg-neutral-500',
        'bg-neutral-800',
    ];

    const WEEKDAY_LABELS = computed(() => {
        const formatter = new Intl.DateTimeFormat(locale.value, {
            weekday: 'narrow',
            timeZone: 'UTC',
        });
        // 只标 1/3/5 行，全标会盖住格子
        return [1, 3, 5].map((row) => ({
            row,
            text: formatter.format(new Date(Date.UTC(2026, 0, 4 + row))),
        }));
    });

    function opacityOf(index: number): number {
        if (highlight.value === null) return 1;
        return model.value.levels[index] === highlight.value ? 1 : 0.22;
    }
</script>

<template>
    <figure class="m-0 min-w-0">
        <div ref="containerRef" class="relative">
            <svg
                :viewBox="`0 0 ${naturalWidth} ${naturalHeight}`"
                :width="renderWidth"
                :height="renderHeight"
                class="block max-w-full outline-none"
                role="img"
                :aria-label="label"
                tabindex="0"
                @keydown="onKeydown"
                @blur="focusIndex = null"
            >
                <!-- 月份 -->
                <text
                    v-for="month in model.months"
                    :key="`m-${month.column}`"
                    :x="GUTTER + month.column * STEP"
                    y="11"
                    class="fill-neutral-500"
                    font-size="10"
                >
                    {{ month.label }}
                </text>

                <!-- 星期 -->
                <text
                    v-for="day in WEEKDAY_LABELS"
                    :key="`w-${day.row}`"
                    :x="GUTTER - 5"
                    :y="HEADER + day.row * STEP + CELL * 0.82"
                    text-anchor="end"
                    class="fill-neutral-400"
                    font-size="9"
                >
                    {{ day.text }}
                </text>

                <g :transform="`translate(${GUTTER}, ${HEADER})`">
                    <rect
                        v-for="(level, index) in model.levels"
                        :key="index"
                        :data-day="toIso(model.start + index * 86400000)"
                        :data-level="level"
                        :x="slotOf(model, index).column * STEP"
                        :y="slotOf(model, index).row * STEP"
                        :width="CELL"
                        :height="CELL"
                        rx="2.5"
                        :class="LEVEL_FILL[level]"
                        :style="{
                            opacity: revealed ? opacityOf(index) : 0,
                            transition: `opacity 280ms ease-out ${delayOf(slotOf(model, index).column)}`,
                            cursor: 'pointer',
                        }"
                        @pointerenter="focusIndex = index"
                        @pointerleave="focusIndex = null"
                    />
                </g>
            </svg>

            <!-- 一个气泡跟住当前格子 -->
            <div
                v-if="activeCell"
                class="pointer-events-none absolute z-10 rounded-[9px] border border-neutral-200 bg-white px-2.5 py-1.5 text-[11px] whitespace-nowrap shadow-sm"
                :style="bubbleStyle"
                data-testid="activity-heatmap-tooltip"
            >
                <div class="text-neutral-900 tabular-nums">
                    {{
                        activeCell.count === 0
                            ? `0 ${unitText}`
                            : `${formatValue(activeCell.count)} ${unitText}`
                    }}
                </div>
                <div class="text-neutral-500">{{ dateText(activeCell.date) }}</div>
                <div v-if="detailOf?.(activeCell.date)" class="text-neutral-400 tabular-nums">
                    {{ detailOf(activeCell.date) }}
                </div>
            </div>
        </div>

        <!-- 图例：悬停预览、点击固定，并说明这一档有多少天 -->
        <figcaption class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
            <span class="mr-0.5">{{ unitLabel }}</span>
            <button
                v-for="(className, index) in LEVEL_BG"
                :key="index"
                type="button"
                :class="[
                    'h-2.5 w-2.5 rounded-[2px] transition-transform',
                    className,
                    pinned === index ? 'scale-125 ring-1 ring-neutral-900/40' : '',
                ]"
                :aria-label="`${index} ${unitText}`"
                :aria-pressed="pinned === index"
                @pointerenter="previewLevel(index)"
                @pointerleave="previewLevel(null)"
                @click="pinLevel(index)"
            />
            <span
                v-if="highlight !== null"
                class="ml-1 text-neutral-400 tabular-nums"
                data-testid="activity-heatmap-caption"
            >
                {{ levelDays[highlight] ?? 0 }} {{ dayLabel }}
            </span>
        </figcaption>
    </figure>
</template>
