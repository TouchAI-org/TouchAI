import type { Meta, StoryObj } from '@storybook/vue3-vite';

import Input from './Input.vue';

/**
 * The text input in both variants and every state a user can meet.
 *
 * `default` and `filled` differ by more than a background: they also differ in
 * height, radius and text size, so a change that merges them is a visible layout
 * shift that only a side-by-side render shows.
 */
const meta = {
    title: 'Primitives/Input',
    component: Input,
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VariantsAndStates: Story = {
    render: () => ({
        components: { Input },
        data: () => ({ text: 'https://api.openai.com', empty: '' }),
        template: `
            <div class="flex flex-col gap-6 p-8">
                <div class="flex flex-col gap-2">
                    <p class="text-dense text-text-tertiary">default</p>
                    <Input v-model="text" placeholder="https://example.com" />
                    <Input v-model="empty" placeholder="Empty with placeholder" />
                    <Input v-model="text" disabled />
                </div>
                <div class="flex flex-col gap-2">
                    <p class="text-dense text-text-tertiary">filled</p>
                    <Input v-model="text" variant="filled" />
                    <Input v-model="empty" variant="filled" placeholder="Search models..." />
                    <Input v-model="text" variant="filled" disabled />
                </div>
            </div>
        `,
    }),
};
