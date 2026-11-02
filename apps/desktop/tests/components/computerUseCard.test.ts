import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { ToolCallInfo } from '@/types/session';
import ComputerUseToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ComputerUseToolCallItem.vue';

/*
 * The computer-use card is the only place a user sees what the agent did to a
 * window: which action, on which target, whether the driver confirmed it, and
 * how fast. All of that has to survive the collapsed state, because the list is
 * scanned without expanding every row.
 */

function toolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
    return {
        id: 'call-1',
        name: 'computer_use',
        namespacedName: 'builtin__computer_use',
        status: 'completed',
        arguments: {
            action: 'click',
            pid: 12,
            window_id: 34,
            element_token: 's1:3',
        },
        result: '{"route":"accessibility","effect":"unverifiable"}',
        ...overrides,
    } as unknown as ToolCallInfo;
}

const stubs = {
    AppIcon: true,
    MotionCollapse: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
};

describe('computer use action card', () => {
    it('user sees the action, the target and the outcome without expanding', () => {
        const wrapper = mount(ComputerUseToolCallItem, {
            props: { toolCall: toolCall(), verbText: '电脑操作' },
            global: { stubs },
        });

        const row = wrapper.get('[data-testid="computer-use-card"]').text();
        expect(row).toContain('电脑操作');
        expect(row).toContain('pid 12 · 34');
        expect(row).toContain('已完成');
    });

    it('user sees arguments and the driver verdict after expanding', async () => {
        const wrapper = mount(ComputerUseToolCallItem, {
            props: { toolCall: toolCall() },
            global: { stubs },
        });

        expect(wrapper.text()).not.toContain('element_token');

        await wrapper.get('button').trigger('click');

        const expanded = wrapper.text();
        expect(expanded).toContain('element_token=s1:3');
        expect(expanded).toContain('accessibility');
        expect(expanded).toContain('未验证');
    });

    it('user sees a confirmed action marked as confirmed', async () => {
        const wrapper = mount(ComputerUseToolCallItem, {
            props: {
                toolCall: toolCall({ result: '{"route":"ax","effect":"confirmed"}' }),
            },
            global: { stubs },
        });

        await wrapper.get('button').trigger('click');

        expect(wrapper.text()).toContain('已确认');
    });

    it('user sees a failed action reported as failed', () => {
        const wrapper = mount(ComputerUseToolCallItem, {
            props: { toolCall: toolCall({ status: 'error', result: 'window_target_not_found' }) },
            global: { stubs },
        });

        expect(wrapper.text()).toContain('失败');
        expect(wrapper.get('[data-testid="computer-use-status"]').classes()).toContain(
            'text-destructive'
        );
    });
});
