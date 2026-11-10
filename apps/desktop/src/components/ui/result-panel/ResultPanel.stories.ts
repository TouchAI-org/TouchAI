import type { Meta, StoryObj } from '@storybook/vue3-vite';

import ResultItem from './ResultItem.vue';
import ResultPanel from './ResultPanel.vue';

const meta = {
    title: 'Primitives/ResultPanel',
    component: ResultPanel,
} satisfies Meta<typeof ResultPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResultStates: Story = {
    render: () => ({
        components: { ResultItem, ResultPanel },
        setup: () => ({
            shortcuts: [
                { keys: ['↑', '↓'], label: 'Navigate' },
                { keys: ['Enter', 'Tab'], separator: '/', label: 'Insert' },
                { keys: ['Esc'], label: 'Close' },
            ],
        }),
        template: `
            <div class="flex w-full max-w-3xl flex-col gap-4 p-8">
                <ResultPanel list-id="preview-choices" list-label="Commands" :shortcuts="shortcuts">
                    <ResultItem label="Open workspace" description="Continue working" highlighted role="option" aria-selected="true" />
                    <ResultItem label="Recent workspace" description="An earlier project" role="option" aria-selected="false" />
                    <ResultItem label="Unavailable workspace" disabled role="option" aria-selected="false" />
                </ResultPanel>
                <ResultPanel layout="grid" :shortcuts="shortcuts" status="3 results">
                    <div class="grid w-full grid-cols-3 gap-2">
                        <ResultItem layout="grid" label="Open workspace" highlighted />
                        <ResultItem layout="grid" label="Recent workspace" />
                        <ResultItem layout="grid" label="Unavailable workspace" disabled />
                    </div>
                </ResultPanel>
                <ResultPanel :state="{ kind: 'loading', message: 'Loading results…' }" />
                <ResultPanel :state="{ kind: 'empty', message: 'No matching results' }" />
                <ResultPanel :state="{ kind: 'error', message: 'Unable to load results' }" />
            </div>
        `,
    }),
};
