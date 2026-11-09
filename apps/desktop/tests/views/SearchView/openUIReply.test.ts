import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    dispatchVisualReplyLink,
    dispatchVisualReplyPrompt,
    registerVisualReplyHost,
} from '@/services/VisualReplyService/bridge';
import OpenUIReply from '@/views/SearchView/components/ConversationPanel/components/OpenUIReply.vue';

const wrappers: VueWrapper[] = [];

function render(response: string, isStreaming = false) {
    const wrapper = mount(OpenUIReply, {
        props: { response, isStreaming },
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
        expect(wrapper.findAll('.visual-reply-chart path')).toHaveLength(2);
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

    it('user cannot trigger conversation or link actions while the reply is streaming', async () => {
        const sendPrompt = vi.fn();
        const openLink = vi.fn();
        registerVisualReplyHost({ sendPrompt, openLink });
        const wrapper = render(
            'root = Root([ActionButton("Continue", "Summarize this chart"), LinkButton("Source", "https://example.com/report")])',
            true
        );

        const buttons = wrapper.findAll('button');
        expect(buttons).toHaveLength(2);
        expect(buttons.every((button) => (button.element as HTMLButtonElement).disabled)).toBe(
            true
        );
        await Promise.all(buttons.map((button) => button.trigger('click')));

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(openLink).not.toHaveBeenCalled();
    });

    it('user sees no action from merely remounting a completed reply', async () => {
        const sendPrompt = vi.fn();
        registerVisualReplyHost({ sendPrompt, openLink: vi.fn() });
        const response = 'root = Root([ActionButton("Continue", "Summarize this chart")])';
        const wrapper = render(response, false);

        wrapper.unmount();
        const restored = render(response, false);
        await flushPromises();

        expect(sendPrompt).not.toHaveBeenCalled();
        expect((restored.get('button').element as HTMLButtonElement).disabled).toBe(false);
    });

    it('user triggers one action after streaming ends without remounting', async () => {
        const sendPrompt = vi.fn();
        registerVisualReplyHost({ sendPrompt, openLink: vi.fn() });
        const wrapper = render(
            'root = Root([ActionButton("Continue", "Summarize this chart")])',
            true
        );

        await wrapper.setProps({ isStreaming: false });
        expect((wrapper.get('button').element as HTMLButtonElement).disabled).toBe(false);
        await wrapper.get('button').trigger('click');

        expect(sendPrompt).toHaveBeenCalledTimes(1);
        expect(sendPrompt).toHaveBeenCalledWith('Summarize this chart');
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
        expect(dispatchVisualReplyLink('https://example.com')).toBe(false);
        expect(sendPrompt).not.toHaveBeenCalled();
    });
});
