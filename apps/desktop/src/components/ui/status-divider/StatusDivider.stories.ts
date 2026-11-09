import type { Meta, StoryObj } from '@storybook/vue3-vite';

import StatusDivider from './StatusDivider.vue';

const meta = {
    title: 'Primitives/StatusDivider',
    component: StatusDivider,
    args: { icon: 'compress', label: 'Context compacted' },
    decorators: [() => ({ template: '<div class="font-sans"><story /></div>' })],
} satisfies Meta<typeof StatusDivider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Completed: Story = {};
export const Loading: Story = { args: { label: 'Compacting context', loading: true } };
export const Chinese: Story = { args: { label: '上下文已压缩' } };
export const ChineseLoading: Story = { args: { label: '正在压缩上下文', loading: true } };
