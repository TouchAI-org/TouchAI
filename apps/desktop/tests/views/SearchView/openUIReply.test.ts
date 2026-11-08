import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    dispatchVisualReplyPrompt,
    registerVisualReplyHost,
} from '@/services/VisualReplyService/bridge';
import OpenUIReply from '@/views/SearchView/components/ConversationPanel/components/OpenUIReply.vue';

const wrappers: VueWrapper[] = [];

function render(response: string) {
    const wrapper = mount(OpenUIReply, {
        props: { response, isStreaming: false },
    });
    wrappers.push(wrapper);
    return wrapper;
}

afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    registerVisualReplyHost({ sendPrompt: vi.fn(), openLink: vi.fn() })();
    vi.restoreAllMocks();
});

describe('when a model returns a visual reply', () => {
    it('user sees real OpenUI components with parsed values', async () => {
        const wrapper = render(
            'root = Root([Heading("Quarterly revenue"), Metric("Q2 revenue", "$58k", "+12%"), BarChart("Revenue", [42, 58], ["Q1", "Q2"])])'
        );
        await flushPromises();

        expect(wrapper.text()).toContain('Quarterly revenue');
        expect(wrapper.text()).toContain('$58k');
        expect(wrapper.text()).toContain('+12%');
        expect(wrapper.get('svg[role="img"]').attributes('aria-label')).toBe('Revenue');
        expect(wrapper.findAll('rect.visual-reply-bar')).toHaveLength(2);
    });

    it('user can continue the conversation from an OpenUI action', async () => {
        const sendPrompt = vi.fn();
        registerVisualReplyHost({ sendPrompt, openLink: vi.fn() });
        const wrapper = render(
            'root = Root([ActionButton("Compare quarters", "Compare Q1 and Q2 revenue")])'
        );
        await wrapper.get('button').trigger('click');

        expect(sendPrompt).toHaveBeenCalledWith('Compare Q1 and Q2 revenue');
    });

    it('user sees an actionable parse error when output is outside the component library', async () => {
        const wrapper = render('root = Root([UnknownCard("hello")])');
        await flushPromises();

        expect(wrapper.get('[role="status"]').text()).toContain('Unknown component');
    });

    it('user cannot trigger actions after the search host is disposed', () => {
        const sendPrompt = vi.fn();
        const dispose = registerVisualReplyHost({ sendPrompt, openLink: vi.fn() });
        dispose();

        expect(dispatchVisualReplyPrompt('continue')).toBe(false);
        expect(sendPrompt).not.toHaveBeenCalled();
    });
});
