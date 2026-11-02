import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { nextTick, onMounted, ref } from 'vue';

import MessageScroller from './MessageScroller.vue';
import type { MessageScrollerHandle, MessageScrollerItem } from './types';

/**
 * Three rail densities at different scroll positions, plus a persistent hover state.
 *
 * The empty viewports isolate visible-message colouring and vertical placement. The
 * wider hover stage gives the preview enough room to show its typography and line limits.
 */
const meta = {
    title: 'Primitives/MessageScroller',
    component: MessageScroller,
} satisfies Meta<typeof MessageScroller>;

export default meta;
type Story = StoryObj<typeof meta>;

const variants = [
    { id: 'short', count: 6, activeIndex: 3 },
    { id: 'medium', count: 9, activeIndex: 4 },
    { id: 'long', count: 13, activeIndex: 10 },
] as const;

function buildItems(prefix: string, count: number): MessageScrollerItem[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index + 1}`,
        label: `Message ${index + 1}`,
    }));
}

const variantItems = variants.map((variant) => buildItems(variant.id, variant.count));
const HOVER_INDEX = 3;
const hoverItems = buildItems('hover', 6).map((item) => ({
    ...item,
    label: 'How does the message rail keep long conversations easy to navigate?',
    description:
        'The rail stays at the right edge, highlights the turns nearest the viewport, and turns a nearby group of ticks into a wave while the preview shows where the current question belongs.',
}));

export const NavigationRail: Story = {
    args: {
        items: variantItems[0],
        label: 'Conversation',
        navigationLabel: 'Message navigation',
        emptyLabel: 'Message',
        navigation: 'rail',
        followOutput: false,
        smooth: false,
    },
    render: (args) => ({
        components: { MessageScroller },
        setup: () => {
            const scrollers = variants.map(() => ref<MessageScrollerHandle | null>(null));
            const hoverScroller = ref<MessageScrollerHandle | null>(null);

            function setScroller(index: number, handle: unknown): void {
                scrollers[index]!.value = handle as MessageScrollerHandle | null;
            }

            function setHoverScroller(handle: unknown): void {
                hoverScroller.value = handle as MessageScrollerHandle | null;
            }

            onMounted(async () => {
                await nextTick();
                await nextTick();

                variants.forEach((variant, index) => {
                    const activeItem = variantItems[index]![variant.activeIndex]!;
                    scrollers[index]!.value?.scrollToItem(activeItem.id, {
                        align: 'center',
                        behavior: 'auto',
                    });
                });

                hoverScroller.value?.scrollToItem(hoverItems[HOVER_INDEX]!.id, {
                    align: 'center',
                    behavior: 'auto',
                });
                await nextTick();

                const hoverStage = document.querySelector<HTMLElement>(
                    '[data-story-message-scroller-hover]'
                );
                const hoverTick = hoverStage?.querySelectorAll<HTMLElement>(
                    '[data-slot="message-scroller-rail-item"]'
                )[HOVER_INDEX];
                hoverTick?.dispatchEvent(
                    new PointerEvent('pointerenter', {
                        pointerType: 'mouse',
                        buttons: 0,
                    })
                );
            });

            return {
                args,
                hoverItems,
                hoverScroller,
                setHoverScroller,
                setScroller,
                variantItems,
                variants,
            };
        },
        template: `
            <div class="flex min-h-screen flex-col items-center justify-center gap-6 p-10">
                <div class="flex items-center justify-center gap-12">
                    <div
                        v-for="(variant, index) in variants"
                        :key="variant.id"
                        class="h-56 w-32 overflow-hidden"
                    >
                        <MessageScroller
                            v-bind="args"
                            :items="variantItems[index]"
                            :ref="(handle) => setScroller(index, handle)"
                            class="h-full"
                            viewport-class="px-3"
                        >
                            <div
                                v-for="item in variantItems[index]"
                                :key="item.id"
                                :data-message-scroller-item="item.id"
                                aria-hidden="true"
                                class="h-20"
                            />
                        </MessageScroller>
                    </div>
                </div>

                <div class="h-80 w-80 overflow-hidden" data-story-message-scroller-hover>
                    <MessageScroller
                        v-bind="args"
                        :items="hoverItems"
                        :ref="setHoverScroller"
                        class="h-full"
                        viewport-class="px-6"
                    >
                        <div
                            v-for="item in hoverItems"
                            :key="item.id"
                            :data-message-scroller-item="item.id"
                            aria-hidden="true"
                            class="h-20"
                        />
                    </MessageScroller>
                </div>
            </div>
        `,
    }),
};
