import type { Meta, StoryObj } from '@storybook/vue3-vite';

import Button from './Button.vue';

/**
 * Every button variant and size the app uses.
 *
 * Variants are the cheapest place for token drift to hide: if one variant's colour
 * changes, no screenshot of a screen that does not render that variant will show
 * it. Rendering them all at once makes such a change a single obvious diff.
 *
 * `variant` also drives which base layout applies (default, settings, icon), so
 * this story is really a matrix of the three families the design system keeps.
 */
const meta = {
    title: 'Primitives/Button',
    component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
    render: () => ({
        components: { Button },
        template: `
            <div class="flex flex-col gap-6 p-8">
                <div class="flex flex-wrap items-center gap-3">
                    <Button>Default</Button>
                    <Button variant="secondary">Secondary</Button>
                    <Button variant="outline">Outline</Button>
                    <Button variant="ghost">Ghost</Button>
                    <Button variant="destructive">Destructive</Button>
                    <Button variant="link">Link</Button>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                    <Button variant="strong">Strong</Button>
                    <Button variant="danger">Danger</Button>
                    <Button variant="outline-neutral">Outline neutral</Button>
                    <Button variant="ghost-neutral">Ghost neutral</Button>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                    <Button size="sm">Small</Button>
                    <Button size="lg">Large</Button>
                    <Button size="icon" aria-label="Icon button">+</Button>
                    <Button size="icon-sm" aria-label="Small icon button">+</Button>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                    <Button disabled>Disabled</Button>
                    <Button variant="outline" disabled>Disabled outline</Button>
                </div>
            </div>
        `,
    }),
};
