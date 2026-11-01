import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    MessageScroller,
    type MessageScrollerHandle,
    type MessageScrollerItem,
} from '@/components/ui/message-scroller';

const items: MessageScrollerItem[] = [
    { id: 'm1', label: 'First question', role: 'user' },
    { id: 'a1', label: 'First answer', role: 'assistant' },
];

const mountedWrappers: Array<{ unmount: () => void }> = [];

function mountScroller(itemScrollTarget: (id: string, options: unknown) => boolean) {
    const wrapper = mount(MessageScroller, {
        attachTo: document.body,
        props: {
            items,
            label: 'Conversation',
            navigationLabel: 'Message navigation',
            emptyLabel: 'Message',
            navigation: 'rail',
            followOutput: false,
            smooth: false,
            itemScrollTarget,
        },
        slots: {
            default: items
                .map((item) => `<div data-message-scroller-item="${item.id}">${item.label}</div>`)
                .join(''),
        },
    });
    mountedWrappers.push(wrapper);
    return wrapper;
}

afterEach(() => {
    while (mountedWrappers.length > 0) {
        mountedWrappers.pop()?.unmount();
    }
});

describe('when the message list is virtualized', () => {
    it('user can jump to a message that has no element mounted yet', async () => {
        const target = vi.fn(() => true);
        const wrapper = mountScroller(target);
        await flushPromises();

        const scroller = wrapper.vm as unknown as MessageScrollerHandle;
        const scrolled = scroller.scrollToItem('a1', { align: 'start', offset: 12 });

        expect(scrolled).toBe(true);
        expect(target).toHaveBeenCalledWith('a1', expect.objectContaining({ align: 'start' }));
    });

    it('user gets no jump when the virtualizer cannot resolve the message', async () => {
        const wrapper = mountScroller(() => false);
        await flushPromises();

        const scroller = wrapper.vm as unknown as MessageScrollerHandle;

        expect(scroller.scrollToItem('missing')).toBe(false);
    });

    it('user gets the scroll viewport so a virtualizer can attach to it', async () => {
        const wrapper = mountScroller(() => true);
        await flushPromises();

        const scroller = wrapper.vm as unknown as MessageScrollerHandle;

        expect(scroller.getViewportElement()).toBe(wrapper.get('section').element);
    });
});
