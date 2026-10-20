<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageHeatmapDay } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { formatCost, formatTokensCompact } from '../utils/format';

    interface Props {
        days: UsageHeatmapDay[];
        /** 展示的周数，由所选区间跨度算出 */
        weeks: number;
    }

    const props = defineProps<Props>();

    defineOptions({ name: 'UsageHeatmap' });

    const CELL = 11;
    const GAP = 3;
    const WEEKDAYS = 7;

    /** 把稀疏的日数据铺成完整网格，没数据的日子也要占位 */
    const grid = computed(() => {
        const byDay = new Map(props.days.map((day) => [day.day, day]));

        const totalDays = props.weeks * WEEKDAYS;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // 对齐到周末，让最后一列是完整的一周
        const end = new Date(today);
        end.setDate(end.getDate() + (6 - end.getDay()));

        const cells: Array<{
            day: string;
            column: number;
            row: number;
            requests: number;
            tokens: number;
            costMicros: number;
            future: boolean;
        }> = [];

        for (let index = totalDays - 1; index >= 0; index -= 1) {
            const date = new Date(end);
            date.setDate(end.getDate() - index);

            const key = localDayKey(date);
            const entry = byDay.get(key);
            const offset = totalDays - 1 - index;

            cells.push({
                day: key,
                column: Math.floor(offset / WEEKDAYS),
                row: offset % WEEKDAYS,
                requests: entry?.requests ?? 0,
                tokens: entry?.tokens ?? 0,
                costMicros: entry?.costMicros ?? 0,
                future: date.getTime() > today.getTime(),
            });
        }

        return cells;
    });

    function localDayKey(date: Date): string {
        return [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0'),
        ].join('-');
    }

    /**
     * 分位数阀值。
     *
     * 用分位数而不是均值：使用量分布长尾很重，用均值会让大多数日子
     * 挤在同一档，看不出差别。没有数据时全部为 0，所有非零日子归为第 1 档。
     */
    const thresholds = computed(() => {
        const values = props.days
            .map((day) => day.tokens)
            .filter((value) => value > 0)
            .sort((left, right) => left - right);

        if (values.length === 0) return { q2: 0, q3: 0, q4: 0 };

        const pick = (ratio: number) =>
            values[Math.min(values.length - 1, Math.floor(values.length * ratio))]!;
        return { q2: pick(0.5), q3: pick(0.75), q4: pick(0.9) };
    });

    /** 0–4 档，与图例一致 */
    function levelOf(tokens: number): number {
        if (tokens <= 0) return 0;
        const { q2, q3, q4 } = thresholds.value;
        if (q4 > 0 && tokens >= q4) return 4;
        if (q3 > 0 && tokens >= q3) return 3;
        if (q2 > 0 && tokens >= q2) return 2;
        return 1;
    }

    /**
     * SVG rect 的档位填充色。
     *
     * 必须用 `fill-*` 而不是 `bg-*`：`bg-*` 写的是 background-color，
     * 对 SVG 图形不生效，rect 会回退到默认黑色。
     */
    const LEVEL_FILL = [
        'fill-neutral-100',
        'fill-neutral-200',
        'fill-neutral-300',
        'fill-neutral-500',
        'fill-neutral-800',
    ];

    /** 图例是普通 div，这里才用 `bg-*` */
    const LEVEL_BG = [
        'bg-neutral-100',
        'bg-neutral-200',
        'bg-neutral-300',
        'bg-neutral-500',
        'bg-neutral-800',
    ];

    const width = computed(() => props.weeks * (CELL + GAP));
    const height = WEEKDAYS * (CELL + GAP);

    const activeDays = computed(() => props.days.filter((day) => day.requests > 0).length);
    const totalTokens = computed(() => props.days.reduce((sum, day) => sum + day.tokens, 0));

    /** 月份标签只标在每月的第一列上 */
    const monthLabels = computed(() => {
        const labels: Array<{ column: number; text: string }> = [];
        let seenMonth = '';

        for (let column = 0; column < props.weeks; column += 1) {
            const cell = grid.value.find((item) => item.column === column && item.row === 0);
            if (!cell) continue;
            const month = cell.day.slice(0, 7);
            if (month === seenMonth) continue;
            seenMonth = month;
            labels.push({ column, text: `${Number(cell.day.slice(5, 7))}月` });
        }

        // 相邻标签太近会叠字，隔一个丢一个
        return labels.filter((label, index) => {
            const previous = labels[index - 1];
            return !previous || label.column - previous.column >= 3;
        });
    });
</script>

<template>
    <section class="space-y-4" data-testid="settings-usage-heatmap">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="settings-section-title">{{ t('settings.usage.heatmap.title') }}</h2>
            <span class="text-[11px] text-neutral-500">
                {{
                    t('settings.usage.heatmap.summary', {
                        days: activeDays,
                        tokens: formatTokensCompact(totalTokens),
                    })
                }}
            </span>
        </div>

        <div class="settings-row-group p-4">
            <!-- 用 viewBox + w-full 自适应容器宽度，避免出现横向滚动条 -->
            <svg
                :viewBox="`0 0 ${width} ${height + 16}`"
                class="w-full"
                role="img"
                :aria-label="t('settings.usage.heatmap.title')"
            >
                <text
                    v-for="label in monthLabels"
                    :key="label.column"
                    :x="label.column * (CELL + GAP)"
                    y="9"
                    class="fill-neutral-400"
                    font-size="9"
                >
                    {{ label.text }}
                </text>

                <g :transform="`translate(0, 16)`">
                    <rect
                        v-for="cell in grid"
                        :key="cell.day"
                        :x="cell.column * (CELL + GAP)"
                        :y="cell.row * (CELL + GAP)"
                        :width="CELL"
                        :height="CELL"
                        rx="2.5"
                        :class="cell.future ? 'fill-neutral-50' : LEVEL_FILL[levelOf(cell.tokens)]"
                    >
                        <title>
                            {{
                                t('settings.usage.heatmap.tooltip', {
                                    day: cell.day,
                                    requests: cell.requests,
                                    tokens: formatTokensCompact(cell.tokens),
                                    cost: formatCost(cell.costMicros),
                                })
                            }}
                        </title>
                    </rect>
                </g>
            </svg>

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
