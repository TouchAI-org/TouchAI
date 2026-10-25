import type { Meta, StoryObj } from '@storybook/vue3-vite';

import Button from '../button/Button.vue';
import { Tooltip, TooltipContent, TooltipTrigger } from './index';

/**
 * A tooltip, open.
 *
 * The tooltip surface (radius, padding, text size, arrow offset) is only visible
 * while hovering, so a screen-level baseline almost never captures it. Rendering it
 * open covers a component that otherwise has no visual coverage at all.
 */
const meta = {
    title: 'Primitives/Tooltip',
    component: Tooltip,
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
    args: {
        open: true,
    },
    render: () => ({
        components: { Tooltip, TooltipContent, TooltipTrigger, Button },
        data: () => ({ open: true }),
        template: `
            <div class="flex min-h-screen items-center justify-center">
                <Tooltip :open="open" @update:open="open = $event">
                    <TooltipTrigger as-child>
                        <Button variant="outline">Hover me</Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy the message to the clipboard</TooltipContent>
                </Tooltip>
            </div>
        `,
    }),
};
