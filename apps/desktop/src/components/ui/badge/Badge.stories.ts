import type { Meta, StoryObj } from '@storybook/vue3-vite';

import Badge from './Badge.vue';

/**
 * Every badge variant, size and tone, including the inactive state.
 *
 * The tone palette is hard-coded per colour rather than derived from a ramp, so a
 * palette change elsewhere in the design system does not reach it. Rendering all
 * seven tones side by side is what makes that visible.
 */
const meta = {
    title: 'Primitives/Badge',
    component: Badge,
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

const TONES = ['blue', 'green', 'purple', 'orange', 'indigo', 'gray', 'neutral'] as const;

export const TonesAndSizes: Story = {
    render: () => ({
        components: { Badge },
        data: () => ({ tones: TONES }),
        template: `
            <div class="flex flex-col gap-6 p-8">
                <div class="flex flex-col gap-2">
                    <p class="text-dense text-text-tertiary">toggle, active</p>
                    <div class="flex flex-wrap items-center gap-2">
                        <Badge v-for="tone in tones" :key="tone" :tone="tone">{{ tone }}</Badge>
                    </div>
                </div>
                <div class="flex flex-col gap-2">
                    <p class="text-dense text-text-tertiary">toggle, inactive (all collapse to neutral)</p>
                    <div class="flex flex-wrap items-center gap-2">
                        <Badge v-for="tone in tones" :key="tone" :tone="tone" :active="false">{{ tone }}</Badge>
                    </div>
                </div>
                <div class="flex flex-col gap-2">
                    <p class="text-dense text-text-tertiary">tag, with explicit sizes</p>
                    <div class="flex flex-wrap items-center gap-2">
                        <Badge variant="tag" size="sm">built-in</Badge>
                        <Badge variant="tag" size="md">built-in</Badge>
                        <Badge variant="tag" size="sm" tone="purple">custom</Badge>
                        <Badge variant="tag" size="md" tone="green">active</Badge>
                    </div>
                </div>
            </div>
        `,
    }),
};
