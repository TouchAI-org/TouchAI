import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { ToolCallInfo } from '@/types/session';
import ToolCallSection from '@/views/SearchView/components/ConversationPanel/components/ToolCallSection.vue';

/**
 * The tool-call section is the only place the user sees what the agent did. Its summary has to
 * match the calls it holds, and it has to open itself while work is running: a collapsed section
 * during execution looks like the agent has stopped.
 */
function toolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
    return {
        id: `call-${Math.random().toString(36).slice(2, 8)}`,
        name: 'read_file',
        namespacedName: 'builtin__read_file',
        source: 'builtin',
        arguments: {},
        status: 'completed',
        ...overrides,
    } as ToolCallInfo;
}

function mountSection(toolCalls: ToolCallInfo[], messageContent = 'done') {
    return mount(ToolCallSection, {
        props: { toolCalls, messageContent },
        global: {
            stubs: {
                AppIcon: { props: ['name'], template: '<i :data-icon="name" />' },
                MotionCollapse: {
                    props: ['open'],
                    template: '<div v-if="open"><slot /></div>',
                },
                ToolCallItem: {
                    props: ['toolCall'],
                    template: '<div class="tool-call-item">{{ toolCall.name }}</div>',
                },
            },
        },
    });
}

function trigger(wrapper: ReturnType<typeof mountSection>) {
    return wrapper.find('.tool-call-inline-trigger');
}

describe('user follows what the agent did with tools', () => {
    it('user gets no section when the message used no tools', () => {
        const wrapper = mountSection([]);

        expect(trigger(wrapper).exists()).toBe(false);
        wrapper.unmount();
    });

    it('user gets the total count for a finished run', () => {
        const wrapper = mountSection([toolCall(), toolCall(), toolCall()]);

        expect(trigger(wrapper).text()).toContain('3');
        wrapper.unmount();
    });

    it('user gets the running state while a tool executes', () => {
        const wrapper = mountSection([
            toolCall({ status: 'completed' }),
            toolCall({ status: 'executing' }),
        ]);

        // The running label is what tells the user the agent has not stalled.
        expect(trigger(wrapper).find('.tool-call-inline-running').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets the running state while a tool waits for approval', () => {
        const wrapper = mountSection([toolCall({ status: 'awaiting_approval' })]);

        // Waiting for approval is still work in progress, not a finished run.
        expect(trigger(wrapper).find('.tool-call-inline-running').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets the error state when a tool failed', () => {
        const wrapper = mountSection([
            toolCall({ status: 'completed' }),
            toolCall({ status: 'error' }),
        ]);

        expect(trigger(wrapper).find('.tool-call-inline-error').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets the cancelled state when a tool was cancelled', () => {
        const wrapper = mountSection([toolCall({ status: 'cancelled' })]);

        expect(trigger(wrapper).find('.tool-call-inline-cancelled').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets the running state taking priority over an earlier error', () => {
        const wrapper = mountSection([
            toolCall({ status: 'error' }),
            toolCall({ status: 'executing' }),
        ]);

        // The live state is what the user needs to see while the run continues.
        expect(trigger(wrapper).find('.tool-call-inline-running').exists()).toBe(true);
        expect(trigger(wrapper).find('.tool-call-inline-error').exists()).toBe(false);
        wrapper.unmount();
    });

    it('user gets the latest tool name shown', () => {
        const wrapper = mountSection([
            toolCall({ name: 'read_file' }),
            toolCall({ name: 'write_file' }),
        ]);

        expect(wrapper.find('.tool-call-inline-latest').text()).toBe('write_file');
        wrapper.unmount();
    });

    it('user clicks the header and the calls expand', async () => {
        const wrapper = mountSection([toolCall()]);
        expect(wrapper.findAll('.tool-call-item')).toHaveLength(0);

        await trigger(wrapper).trigger('click');

        expect(wrapper.findAll('.tool-call-item')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user clicks the header twice and the calls collapse again', async () => {
        const wrapper = mountSection([toolCall()]);

        await trigger(wrapper).trigger('click');
        await trigger(wrapper).trigger('click');

        expect(wrapper.findAll('.tool-call-item')).toHaveLength(0);
        wrapper.unmount();
    });

    it('user gets the expanded state reported for assistive technology', async () => {
        const wrapper = mountSection([toolCall()]);
        expect(trigger(wrapper).attributes('aria-expanded')).toBe('false');

        await trigger(wrapper).trigger('click');

        expect(trigger(wrapper).attributes('aria-expanded')).toBe('true');
        wrapper.unmount();
    });

    it('user gets every call rendered once expanded', async () => {
        const wrapper = mountSection([
            toolCall({ name: 'read_file' }),
            toolCall({ name: 'write_file' }),
        ]);

        await trigger(wrapper).trigger('click');

        expect(wrapper.findAll('.tool-call-item')).toHaveLength(2);
        wrapper.unmount();
    });

    it('user gets the section opened by itself when a tool starts executing', async () => {
        const wrapper = mountSection([toolCall({ status: 'completed' })]);
        expect(wrapper.findAll('.tool-call-item')).toHaveLength(0);

        await wrapper.setProps({
            toolCalls: [toolCall({ status: 'completed' }), toolCall({ status: 'executing' })],
        });
        await wrapper.vm.$nextTick();

        // A collapsed section during execution looks like the agent stopped working.
        expect(wrapper.findAll('.tool-call-item').length).toBeGreaterThan(0);
        wrapper.unmount();
    });

    it('user keeps the section closed after collapsing it while a tool runs', async () => {
        const wrapper = mountSection([toolCall({ status: 'executing' })]);
        await trigger(wrapper).trigger('click');
        expect(wrapper.findAll('.tool-call-item')).toHaveLength(0);

        // A later call must not reopen what the user deliberately closed.
        await wrapper.setProps({
            toolCalls: [toolCall({ status: 'executing' }), toolCall({ status: 'executing' })],
        });
        await wrapper.vm.$nextTick();

        expect(wrapper.findAll('.tool-call-item')).toHaveLength(0);
        wrapper.unmount();
    });
});
