import { mountComposable } from '@tests/utils/composables';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import type { SessionMessage } from '@/types/session';
import { useMessageWindowing } from '@/views/SearchView/components/ConversationPanel/composables/useMessageWindowing';

function createMessage(id: string): SessionMessage {
    return { id, role: 'assistant', content: `message ${id}`, parts: [], timestamp: 1 };
}

function createMessages(count: number): SessionMessage[] {
    return Array.from({ length: count }, (_, index) => createMessage(`m${index}`));
}

function rect(top: number): DOMRect {
    return {
        top,
        bottom: top,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
    } as DOMRect;
}

describe('useMessageWindowing', () => {
    it('renders everything when windowing is disabled', async () => {
        const mounted = await mountComposable(() =>
            useMessageWindowing({
                container: ref(null),
                messages: ref(createMessages(100)),
                enabled: ref(false),
                scrollTop: ref(0),
                clientHeight: ref(300),
            })
        );

        expect(mounted.result.renderedMessages.value).toHaveLength(100);
        expect(mounted.result.windowRange.value.topSpacer).toBe(0);
        mounted.unmount();
    });

    it('bounds the mounted messages and keeps estimated offsets jumpable', async () => {
        const scrollTop = ref(70 * 140);
        const mounted = await mountComposable(() =>
            useMessageWindowing({
                container: ref(null),
                messages: ref(createMessages(100)),
                enabled: ref(true),
                scrollTop,
                clientHeight: ref(300),
                estimateHeight: () => 140,
            })
        );

        const ids = mounted.result.renderedMessages.value.map((message) => message.id);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.length).toBeLessThan(100);
        expect(ids).toContain('m70');

        // 未挂载消息也能通过累计高度定位。
        expect(mounted.result.messageOffsetTop('m50')).toBe(50 * 140);
        expect(mounted.result.messageOffsetTop('missing')).toBeNull();
        mounted.unmount();
    });

    it('compensates scrollTop by the difference between estimate and first measurement', async () => {
        // 向顶部加载历史页时，新行先按估值占位；真实高度与估值的差额要补进 scrollTop，
        // 否则用户正在读的位置会被顶开。
        const container = document.createElement('div');
        container.scrollTop = 500;
        container.getBoundingClientRect = () => rect(100);

        const messages = ref([createMessage('m0')]);
        const onProgrammaticScroll = vi.fn();
        const mounted = await mountComposable(() =>
            useMessageWindowing({
                container: ref(container),
                messages,
                enabled: ref(true),
                scrollTop: ref(0),
                clientHeight: ref(300),
                estimateHeight: () => 140,
                onProgrammaticScroll,
            })
        );

        const element = document.createElement('div');
        Object.defineProperty(element, 'offsetHeight', { value: 400, configurable: true });
        element.getBoundingClientRect = () => rect(0);

        mounted.result.registerMessageElement(messages.value[0]!, element);

        expect(container.scrollTop).toBe(500 + (400 - 140));
        expect(onProgrammaticScroll).toHaveBeenCalledTimes(1);
        mounted.unmount();
    });
});
