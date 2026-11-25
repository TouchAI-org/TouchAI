import type { Meta, StoryObj } from '@storybook/vue3-vite';

import Textarea from './Textarea.vue';

const meta = {
    title: 'Primitives/Textarea',
    component: Textarea,
    args: {
        modelValue: 'A plain-text prompt snippet.',
        rows: 5,
    },
    render: (args) => ({
        components: { Textarea },
        setup: () => ({ args }),
        template: '<Textarea v-bind="args" aria-label="Prompt snippet body" />',
    }),
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
