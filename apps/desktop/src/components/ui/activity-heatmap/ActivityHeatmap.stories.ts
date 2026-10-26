import type { Meta, StoryObj } from '@storybook/vue3-vite';

import ActivityHeatmap from './ActivityHeatmap.vue';

/**
 * The activity heatmap with a fixed, generated window.
 *
 * Real data comes from usage records, so its shape changes every day and could never
 * hold a baseline. The story builds a deterministic year from an arithmetic pattern
 * instead, which exercises all five intensity levels and both month rows.
 *
 * The data alone does not make the render reproducible: `yearWindow` anchors the right
 * edge to the current week, so the grid moves as the calendar advances even though the
 * data never changes. `tests/visual/primitives.visual.ts` pins the clock before the page
 * loads, which is what makes this story's baseline stable.
 */
const meta = {
    title: 'Primitives/ActivityHeatmap',
    component: ActivityHeatmap,
} satisfies Meta<typeof ActivityHeatmap>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A year of days with a predictable weekly rhythm and a few quiet stretches. */
function buildDays(): Array<{ date: string; count: number }> {
    const days: Array<{ date: string; count: number }> = [];
    const start = Date.UTC(2025, 0, 1);

    for (let offset = 0; offset < 365; offset += 1) {
        const date = new Date(start + offset * 86_400_000);
        const weekday = date.getUTCDay();
        const quiet = offset % 37 < 5;

        // Weekends are calmer, and the count hashes off the offset so neighbouring
        // cells differ without being random.
        const weekdayFactor = weekday === 0 || weekday === 6 ? 1 : 4;
        const count = quiet ? 0 : ((offset * 7) % 11) + weekdayFactor;

        days.push({ date: date.toISOString().slice(0, 10), count });
    }

    return days;
}

export const OneYear: Story = {
    args: {
        days: [],
        label: 'Tool calls',
    },
    render: () => ({
        components: { ActivityHeatmap },
        data: () => ({ days: buildDays() }),
        template: `
            <div class="p-8">
                <ActivityHeatmap
                    :days="days"
                    label="Tool calls"
                    :year-window="true"
                    :height="150"
                    :format-date="(date) => date.toISOString().slice(0, 10)"
                />
            </div>
        `,
    }),
};
