<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageHeatmapDay } from '@database/queries/usageStats';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { getLocale, t } from '@/i18n';

    import { formatCost, formatTokensCompact } from '../utils/format';
    import { localUsageKey, parseUsageTime } from '../utils/usageOverlay';

    const props = defineProps<{
        days: UsageHeatmapDay[];
        range: { preset: string; from: string; to: string };
    }>();
    defineOptions({ name: 'UsageHeatmap' });

    /**
     * 格子尺寸按模式分别取值。
     *
     * 细粒度只有 24 列 × 几天，继续用 11px 会缩成一条虚线；
     * 粗粒度可能有 53 列，必须小一点否则装不下。
     */
    const FINE_CELL = 26;
    /** 粗粒度也有 53 列的上限，格子不能太大，否则会溢出容器 */
    const COARSE_CELL = 15;

    /** 跨度达到这个天数就切到「星期 × 周」，否则用「小时 × 日期」 */
    const DAY_SCALE_THRESHOLD = 21;

    const bounds = computed(() => {
        const end = new Date(
            props.range.preset === 'all' ? Date.now() : parseUsageTime(props.range.to)
        );
        end.setHours(0, 0, 0, 0);
        const start = new Date(parseUsageTime(props.range.from));
        start.setHours(0, 0, 0, 0);
        const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
        return { start, end, spanDays };
    });

    /** 细粒度：小时 × 日期；粗粒度：星期 × 周 */
    const fine = computed(() => bounds.value.spanDays < DAY_SCALE_THRESHOLD);
    const GUTTER = computed(() => (fine.value ? 46 : 32));
    const containerRef = ref<HTMLElement | null>(null);

    interface Cell {
        key: string;
        day: string;
        column: number;
        row: number;
        inRange: boolean;
        requests: number;
        tokens: number;
        costMicros: number;
        label: string;
    }

    const cells = computed<Cell[]>(() => {
        const result: Cell[] = [];
        const { start, end } = bounds.value;

        if (fine.value) {
            // 细粒度：小时为横轴、日期为纵轴。
            // 反过来（日期为列）在单天区间会只剩一列，右边全是空白。
            const byCell = new Map<
                string,
                { requests: number; tokens: number; costMicros: number }
            >();
            for (const row of props.days) {
                const key = `${row.day} ${row.hour}`;
                const entry = byCell.get(key) ?? { requests: 0, tokens: 0, costMicros: 0 };
                entry.requests += row.requests;
                entry.tokens += row.tokens;
                entry.costMicros += row.costMicros;
                byCell.set(key, entry);
            }

            let dayIndex = 0;
            for (
                const cursor = new Date(start);
                cursor <= end;
                cursor.setDate(cursor.getDate() + 1), dayIndex += 1
            ) {
                const day = localUsageKey(cursor);
                for (let hour = 0; hour < 24; hour += 2) {
                    const first = byCell.get(`${day} ${hour}`);
                    const second = byCell.get(`${day} ${hour + 1}`);
                    result.push({
                        key: `${day} ${hour}`,
                        day,
                        column: hour / 2,
                        row: dayIndex,
                        inRange: true,
                        requests: (first?.requests ?? 0) + (second?.requests ?? 0),
                        tokens: (first?.tokens ?? 0) + (second?.tokens ?? 0),
                        costMicros: (first?.costMicros ?? 0) + (second?.costMicros ?? 0),
                        label: `${day} ${String(hour).padStart(2, '0')}:00`,
                    });
                }
            }
            return result;
        }

        // 粗粒度：按日聚合，星期为行，周为列
        const byDay = new Map<string, { requests: number; tokens: number; costMicros: number }>();
        for (const row of props.days) {
            const entry = byDay.get(row.day) ?? { requests: 0, tokens: 0, costMicros: 0 };
            entry.requests += row.requests;
            entry.tokens += row.tokens;
            entry.costMicros += row.costMicros;
            byDay.set(row.day, entry);
        }

        const firstSunday = new Date(start);
        firstSunday.setDate(firstSunday.getDate() - firstSunday.getDay());
        let offset = 0;
        for (
            const cursor = new Date(firstSunday);
            cursor <= end;
            cursor.setDate(cursor.getDate() + 1), offset += 1
        ) {
            const day = localUsageKey(cursor);
            const entry = byDay.get(day);
            result.push({
                key: day,
                day,
                column: Math.floor(offset / 7),
                row: cursor.getDay(),
                inRange: cursor >= start,
                requests: entry?.requests ?? 0,
                tokens: entry?.tokens ?? 0,
                costMicros: entry?.costMicros ?? 0,
                label: day,
            });
        }
        return result;
    });

    const rows = computed(() => (fine.value ? bounds.value.spanDays : 7));
    const columns = computed(() =>
        Math.max(1, (cells.value[cells.value.length - 1]?.column ?? 0) + 1)
    );

    const visible = computed(() => cells.value.filter((cell) => cell.inRange));
    const totalTokens = computed(() =>
        visible.value.reduce((total, cell) => total + cell.tokens, 0)
    );
    const activeDays = computed(
        () =>
            new Set(visible.value.filter((cell) => cell.requests > 0).map((cell) => cell.day)).size
    );
    const activeHours = computed(() => visible.value.filter((cell) => cell.requests > 0).length);

    /**
     * 分位数阀值。
     *
     * 用分位数而不是均值：用量分布长尾很重，用均值会让大多数格子挤在同一档。
     */
    const thresholds = computed(() => {
        const values = visible.value
            .map((cell) => cell.tokens)
            .filter((value) => value > 0)
            .sort((left, right) => left - right);
        if (values.length === 0) return [0, 0, 0];
        return [0.5, 0.75, 0.9].map(
            (quantile) =>
                values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0
        );
    });

    function levelOf(tokens: number): number {
        if (tokens <= 0) return 0;
        for (let index = 2; index >= 0; index -= 1) {
            if (thresholds.value[index]! > 0 && tokens >= thresholds.value[index]!)
                return index + 2;
        }
        return 1;
    }

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

    /** 列标签：细粒度标日期，粗粒度标月份 */
    const labels = computed(() => {
        if (fine.value) {
            // 2 小时一格，所以 0 / 4 / 8 列分别对应 00:00 / 08:00 / 16:00
            return [0, 4, 8].map((column) => ({
                column,
                text: `${String(column * 2).padStart(2, '0')}:00`,
            }));
        }

        const result: Array<{ column: number; text: string }> = [];
        let lastKey = '';
        for (const cell of visible.value) {
            const key = cell.day.slice(0, 7);
            if (key === lastKey) continue;
            lastKey = key;
            const previous = result[result.length - 1];
            if (previous && cell.column - previous.column < 3) continue;
            result.push({
                column: cell.column,
                text: new Intl.DateTimeFormat(getLocale(), { month: 'short' }).format(
                    new Date(`${cell.day}T12:00:00`)
                ),
            });
        }
        return result;
    });

    /** 行标签：星期名 */
    const rowLabels = computed(() => {
        if (fine.value) {
            const result: Array<{ row: number; text: string }> = [];
            let lastDay = '';
            for (const cell of visible.value) {
                if (cell.day === lastDay) continue;
                lastDay = cell.day;
                result.push({
                    row: cell.row,
                    text: new Intl.DateTimeFormat(getLocale(), {
                        month: 'numeric',
                        day: 'numeric',
                    }).format(new Date(`${cell.day}T12:00:00`)),
                });
            }
            return result;
        }

        const formatter = new Intl.DateTimeFormat(getLocale(), { weekday: 'narrow' });
        return [0, 1, 2, 3, 4, 5, 6].map((row) => ({
            row,
            // 2026-01-05 是周一，用它作参照取星期名
            text: formatter.format(new Date(2026, 0, 4 + row)),
        }));
    });

    /**
     * 按容器宽度求出可用的格子边长。
     *
     * 固定尺寸会让短区间只占很小一块，右边全是空白；
     * 直接拉满又会把方格压成矩形。所以只算边长，保持正方。
     */
    const containerWidth = ref(0);
    /**
     * 格子边长：同时受容器宽度与期望高度约束。
     *
     * 只看宽度会让行数少的月份得到过大的格子（5 列 × 46px 会高到 359px），
     * 所以同时给一个总高度上限，取两者较小的那个。
     */
    const MAX_HEIGHT = 240;
    const cellSize = computed(() => {
        const available = containerWidth.value - GUTTER.value - 8;
        if (available <= 0 || columns.value === 0) return fine.value ? FINE_CELL : COARSE_CELL;
        const byWidth = available / columns.value - 3;
        const byHeight = (MAX_HEIGHT - 16) / rows.value - 3;
        return Math.max(10, Math.min(byWidth, byHeight, 26));
    });
    const step = computed(() => cellSize.value + 3);

    const svgWidth = computed(() => GUTTER.value + columns.value * step.value);
    const svgHeight = computed(() => rows.value * step.value + 16);

    let resizeObserver: ResizeObserver | null = null;
    onMounted(() => {
        const el = containerRef.value;
        if (!el) return;
        containerWidth.value = el.clientWidth;
        // watchEffect 在挂载前读到 0，改由 ResizeObserver 跟踪实际宽度
        resizeObserver = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width ?? 0;
            if (width > 0) containerWidth.value = width;
        });
        resizeObserver.observe(el);
    });
    onUnmounted(() => {
        resizeObserver?.disconnect();
        resizeObserver = null;
    });
</script>

<template>
    <section class="space-y-3" data-testid="settings-usage-heatmap">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="settings-section-title">{{ t('settings.usage.heatmap.title') }}</h2>
            <span class="text-[11px] text-neutral-500">
                {{
                    t(
                        fine
                            ? 'settings.usage.heatmap.summaryHours'
                            : 'settings.usage.heatmap.summary',
                        {
                            days: activeDays,
                            hours: activeHours,
                            tokens: formatTokensCompact(totalTokens),
                        }
                    )
                }}
            </span>
        </div>

        <div class="rounded-[11px] bg-neutral-50/80 p-4">
            <!--
                按格子自然尺寸渲染，不拉到满宽。
                格子必须保持正方：`w-full` + viewBox 会在宽容器里把高度也等比放大，
                或者（父级限制高度时）只铺开很小一块导致大片留白。
            -->
            <div ref="containerRef" class="overflow-x-auto">
                <svg
                    :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
                    :width="svgWidth"
                    :height="svgHeight"
                    class="block"
                    role="img"
                    :aria-label="t('settings.usage.heatmap.title')"
                >
                    <text
                        v-for="label in rowLabels"
                        :key="`row-${label.row}`"
                        :x="GUTTER - 6"
                        :y="16 + label.row * step + cellSize * 0.78"
                        text-anchor="end"
                        class="fill-neutral-400"
                        font-size="9"
                    >
                        {{ label.text }}
                    </text>

                    <text
                        v-for="label in labels"
                        :key="`col-${label.column}`"
                        :x="GUTTER + label.column * step"
                        y="9"
                        class="fill-neutral-400"
                        font-size="9"
                    >
                        {{ label.text }}
                    </text>

                    <g :transform="`translate(${GUTTER}, 16)`">
                        <rect
                            v-for="cell in cells"
                            :key="cell.key"
                            :data-day="cell.inRange ? cell.day : undefined"
                            :data-hour="cell.inRange && fine ? cell.key.split(' ')[1] : undefined"
                            :x="cell.column * step"
                            :y="cell.row * step"
                            :width="cellSize"
                            :height="cellSize"
                            rx="2.5"
                            :class="
                                cell.inRange ? LEVEL_FILL[levelOf(cell.tokens)] : 'fill-transparent'
                            "
                        >
                            <title v-if="cell.inRange">
                                {{
                                    t('settings.usage.heatmap.tooltip', {
                                        day: cell.label,
                                        requests: cell.requests,
                                        tokens: formatTokensCompact(cell.tokens),
                                        cost: formatCost(cell.costMicros),
                                    })
                                }}
                            </title>
                        </rect>
                    </g>
                </svg>
            </div>

            <div class="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
                <span>{{ t('settings.usage.heatmap.less') }}</span>
                <span
                    v-for="(className, index) in LEVEL_BG"
                    :key="index"
                    :class="['h-2.5 w-2.5 rounded-sm', className]"
                    aria-hidden="true"
                />
                <span>{{ t('settings.usage.heatmap.more') }}</span>
            </div>
        </div>
    </section>
</template>
