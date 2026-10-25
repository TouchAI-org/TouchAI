import type { Meta, StoryObj } from '@storybook/vue3-vite';

import Switch from './Switch.vue';

/**
 * Every switch size, tone and state.
 *
 * The three sizes exist because the app historically had three hand-written
 * toggles whose thumbs genuinely differ; collapsing them would itself be a visual
 * change. Rendering them together keeps that distinction visible and catches a
 * token or class edit that would silently merge two of them.
 */
const meta = {
    title: 'Primitives/Switch',
    component: Switch,
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SizesAndStates: Story = {
    render: () => ({
        components: { Switch },
        data: () => ({ on: true, off: false }),
        template: `
            <div class="flex flex-col gap-6 p-8">
                <div class="flex flex-col gap-3">
                    <p class="text-dense text-text-tertiary">small (default)</p>
                    <div class="flex items-center gap-4">
                        <Switch v-model="on" size="sm" />
                        <Switch v-model="off" size="sm" />
                        <Switch :model-value="true" size="sm" disabled />
                        <Switch :model-value="false" size="sm" disabled />
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <p class="text-dense text-text-tertiary">medium</p>
                    <div class="flex items-center gap-4">
                        <Switch v-model="on" size="md" />
                        <Switch v-model="off" size="md" />
                        <Switch :model-value="true" size="md" disabled />
                    </div>
                </div>
                <div class="flex flex-col gap-3">
                    <p class="text-dense text-text-tertiary">large and subtle tone</p>
                    <div class="flex items-center gap-4">
                        <Switch v-model="on" size="lg" />
                        <Switch v-model="off" size="lg" />
                        <Switch v-model="on" size="lg" tone="subtle" />
                        <Switch v-model="off" size="lg" tone="subtle" />
                    </div>
                </div>
            </div>
        `,
    }),
};
