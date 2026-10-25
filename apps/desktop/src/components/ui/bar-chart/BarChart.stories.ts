import type { Meta, StoryObj } from '@storybook/vue3-vite';

import BarChart from './BarChart.vue';

/**
 * The bar chart with a fixed dataset.
 *
 * Charts are where a token change is most expensive to notice by hand: a series
 * colour that shifts by one ramp step still looks plausible next to its legend, and
 * a tick font change is easy to miss. Fixed data makes the whole plot comparable.
 */
const meta = {
    title: 'Primitives/BarChart',
    component: BarChart,
} satisfies Meta<typeof BarChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StackedAndAverage: Story = {
    args: {
        data: [],
        series: [],
        label: 'Tool calls per day',
    },
    render: () => ({
        components: { BarChart },
        data: () => ({
            series: [
                { key: 'search', label: 'Search' },
                { key: 'agent', label: 'Agent' },
            ],
            data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => ({
                key: `day-${index}`,
                label,
                values: {
                    search: 12 + ((index * 5) % 9),
                    agent: 6 + ((index * 3) % 7),
                },
            })),
        }),
        template: `
            <div class="p-8">
                <BarChart
                    :data="data"
                    :series="series"
                    label="Tool calls per day"
                    :show-average="true"
                    :legend="true"
                    :height="220"
                />
            </div>
        `,
    }),
};
