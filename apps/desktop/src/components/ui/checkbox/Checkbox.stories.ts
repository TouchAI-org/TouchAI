import type { Meta, StoryObj } from '@storybook/vue3-vite';

import Checkbox from './Checkbox.vue';

const meta = {
    title: 'Primitives/Checkbox',
    component: Checkbox,
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {
    render: () => ({
        components: { Checkbox },
        template: `
            <div class="flex items-center gap-6 p-4">
                <Checkbox :model-value="false" aria-label="Unselected" />
                <Checkbox :model-value="true" aria-label="Selected" />
                <Checkbox model-value="indeterminate" aria-label="Partly selected" />
                <Checkbox :model-value="true" disabled aria-label="Unavailable" />
            </div>
        `,
    }),
};
