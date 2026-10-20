<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageHeatmapDay } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { getLocale, t } from '@/i18n';

    import { formatCost, formatTokensCompact } from '../utils/format';
    import { localUsageKey, parseUsageTime } from '../utils/usageOverlay';

    const props = defineProps<{
        days: UsageHeatmapDay[];
        range: { preset: string; from: string; to: string };
    }>();
    defineOptions({ name: 'UsageHeatmap' });

    const CELL = 11;
    const STEP = 14;
    const bounds = computed(() => {
        const end = new Date(
            props.range.preset === 'all' ? Date.now() : parseUsageTime(props.range.to)
        );
        end.setHours(0, 0, 0, 0);
        let start = new Date(parseUsageTime(props.range.from));
        start.setHours(0, 0, 0, 0);
        const yearStart = new Date(end);
        yearStart.setFullYear(yearStart.getFullYear() - 1);
        yearStart.setDate(yearStart.getDate() + 1);
        const capped = props.range.preset === 'all' || start < yearStart;
        if (capped) {
            const firstDay = [...props.days].sort((left, right) =>
                left.day.localeCompare(right.day)
            )[0]?.day;
            start = firstDay ? new Date(`${firstDay}T00:00:00`) : new Date(end);
            if (start < yearStart) start = yearStart;
        }
        return { start, end, capped: capped && start.getTime() === yearStart.getTime() };
    });
    const selected = computed(() =>
        props.days.filter(
            (day) =>
                day.day >= localUsageKey(bounds.value.start) &&
                day.day <= localUsageKey(bounds.value.end)
        )
    );
    const grid = computed(() => {
        const byDay = new Map(selected.value.map((day) => [day.day, day]));
        const firstSunday = new Date(bounds.value.start);
        firstSunday.setDate(firstSunday.getDate() - firstSunday.getDay());
        const cells = [];
        let offset = 0;
        for (
            const cursor = new Date(firstSunday);
            cursor <= bounds.value.end;
            cursor.setDate(cursor.getDate() + 1), offset += 1
        ) {
            const day = localUsageKey(cursor);
            const entry = byDay.get(day);
            cells.push({
                day,
                column: Math.floor(offset / 7),
                row: cursor.getDay(),
                inRange: cursor >= bounds.value.start,
                requests: entry?.requests ?? 0,
                tokens: entry?.tokens ?? 0,
                costMicros: entry?.costMicros ?? 0,
            });
        }
        return cells;
    });
    const columns = computed(() =>
        Math.max(1, (grid.value[grid.value.length - 1]?.column ?? 0) + 1)
    );
    const width = computed(() => columns.value * STEP);
    const height = 7 * STEP + 16;
    const totalTokens = computed(() =>
        selected.value.reduce((total, day) => total + day.tokens, 0)
    );
    const activeDays = computed(() => selected.value.filter((day) => day.requests > 0).length);
    const thresholds = computed(() => {
        const values = selected.value
            .map((day) => day.tokens)
            .filter((value) => value > 0)
            .sort((left, right) => left - right);
        return [0.5, 0.75, 0.9].map(
            (quantile) =>
                values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0
        );
    });
    function levelOf(tokens: number) {
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
    const labels = computed(() => {
        const result: Array<{ column: number; text: string }> = [];
        let lastMonth = '';
        for (const cell of grid.value) {
            if (!cell.inRange) continue;
            const month = cell.day.slice(0, 7);
            if (month === lastMonth) continue;
            lastMonth = month;
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
</script>

<template>
    <section class="space-y-4" data-testid="settings-usage-heatmap">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="settings-section-title">{{ t('settings.usage.heatmap.title') }}</h2>
            <span class="text-[11px] text-neutral-500">
                {{
                    t(
                        bounds.capped
                            ? 'settings.usage.heatmap.lastYear'
                            : 'settings.usage.heatmap.summary',
                        { days: activeDays, tokens: formatTokensCompact(totalTokens) }
                    )
                }}
            </span>
        </div>
        <div class="settings-row-group p-4">
            <svg
                :viewBox="`0 0 ${width} ${height}`"
                :width="width"
                :height="height"
                class="block max-w-full"
                role="img"
                :aria-label="t('settings.usage.heatmap.title')"
            >
                <text
                    v-for="label in labels"
                    :key="label.column"
                    :x="label.column * STEP"
                    y="9"
                    class="fill-neutral-400"
                    font-size="9"
                >
                    {{ label.text }}
                </text>
                <g transform="translate(0, 16)">
                    <rect
                        v-for="cell in grid"
                        :key="cell.day"
                        :data-day="cell.inRange ? cell.day : undefined"
                        :x="cell.column * STEP"
                        :y="cell.row * STEP"
                        :width="CELL"
                        :height="CELL"
                        rx="2.5"
                        :class="
                            cell.inRange ? LEVEL_FILL[levelOf(cell.tokens)] : 'fill-transparent'
                        "
                    >
                        <title v-if="cell.inRange">
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
