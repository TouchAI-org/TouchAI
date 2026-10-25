import type { Meta, StoryObj } from '@storybook/vue3-vite';

import DonutChart from './DonutChart.vue';

/**
 * The donut chart with fixed slices.
 *
 * Rendering the same slices twice — once as a ring, once with a large share grouped
 * into "other" — covers the two layouts the component produces from the same tokens.
 */
const meta = {
    title: 'Primitives/DonutChart',
    component: DonutChart,
} satisfies Meta<typeof DonutChart>;

export default meta;
type Story = StoryObj<typeof meta>;

const DATA = [
    { key: 'read', label: 'Read', value: 412 },
    { key: 'bash', label: 'Bash', value: 286 },
    { key: 'search', label: 'FileSearch', value: 168 },
    { key: 'webfetch', label: 'WebFetch', value: 94 },
    { key: 'widget', label: 'ShowWidget', value: 41 },
];

export const Ring: Story = {
    args: {
        data: [],
    },
    render: () => ({
        components: { DonutChart },
        data: () => ({ data: DATA }),
        template: `
            <div class="flex items-center gap-12 p-8">
                <DonutChart :data="data" total-label="Calls" :size="220" />
                <DonutChart :data="data" total-label="Calls" :size="220" :group-below="0.1" />
            </div>
        `,
    }),
};
