import type { Meta, StoryObj } from '@storybook/vue3-vite';

import AnimatedCounter from './AnimatedCounter.vue';

/**
 * Numerals in the shapes the usage dashboard uses them.
 *
 * The component drives a spring from its old value to its new one, so a screenshot
 * taken mid-flight would never match. Stories render with `text` set (no animation)
 * where the number itself matters, and the animated form is only compared at rest.
 */
const meta = {
    title: 'Primitives/AnimatedCounter',
    component: AnimatedCounter,
} satisfies Meta<typeof AnimatedCounter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Shapes: Story = {
    args: {
        value: 0,
    },
    render: () => ({
        components: { AnimatedCounter },
        template: `
            <div class="flex flex-col gap-4 p-8">
                <div class="flex items-baseline gap-8">
                    <AnimatedCounter :value="1284" />
                    <AnimatedCounter :value="1284" suffix=" calls" />
                    <AnimatedCounter :value="97.35" :decimals="1" suffix="%" />
                    <AnimatedCounter :value="0.42" :decimals="2" prefix="$" />
                </div>
                <div class="flex items-baseline gap-8">
                    <AnimatedCounter text="12,345" />
                    <AnimatedCounter text="—" />
                </div>
            </div>
        `,
    }),
};
