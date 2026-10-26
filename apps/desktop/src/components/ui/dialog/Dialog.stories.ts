import type { Meta, StoryObj } from '@storybook/vue3-vite';

import Button from '../button/Button.vue';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from './index';

/**
 * The dialog shell, open.
 *
 * Dialogs render through a portal and a focus trap, which is exactly the kind of
 * chrome a screen-level snapshot is least likely to catch: a dialog may only be
 * reachable after a real user action, and its visual weight (overlay opacity, radius,
 * shadow, spacing) is pure token output. Rendering it open here keeps that surface
 * covered.
 */
const meta = {
    title: 'Primitives/Dialog',
    component: Dialog,
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
    args: {
        open: true,
    },
    render: () => ({
        components: {
            Dialog,
            DialogContent,
            DialogDescription,
            DialogFooter,
            DialogHeader,
            DialogTitle,
            Button,
        },
        data: () => ({ open: true }),
        template: `
            <div class="flex min-h-screen items-center justify-center">
                <Dialog :open="open" @update:open="open = $event">
                    <DialogContent
                        class="w-full max-w-lg gap-4 rounded-panel border border-border bg-surface p-6 shadow-xl"
                    >
                        <DialogHeader>
                            <DialogTitle>Delete this session?</DialogTitle>
                            <DialogDescription>
                                The conversation and its tool logs are removed from this device. This cannot be undone.
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                            <Button variant="outline" @click="open = false">Cancel</Button>
                            <Button variant="destructive" @click="open = false">Delete</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        `,
    }),
};
