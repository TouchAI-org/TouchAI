import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import ToolCallItem from '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue';

enableAutoUnmount(afterEach);
afterEach(() => setLocale('zh-CN'));

function mountCall(argumentsValue: Record<string, unknown>) {
    return mount(ToolCallItem, {
        props: {
            toolCall: {
                id: 'computer-call',
                source: 'builtin',
                name: 'computer_use',
                namespacedName: 'builtin__computer_use',
                arguments: argumentsValue,
                status: 'completed',
                durationMs: 109,
            },
        },
    });
}

describe('computer use activity details', () => {
    it('user given a permission check when reading its activity then sees no process or window identifiers', () => {
        setLocale('en-US');
        const wrapper = mountCall({
            action: 'call',
            tool: 'check_permissions',
            arguments: { pid: 144544, window_id: 67502756 },
        });
        expect(wrapper.text()).toContain('Check permissions');
        const text = wrapper.text();
        expect(text).not.toContain('144544');
        expect(text).not.toContain('67502756');
    });

    it('user given a click at a point when reading its activity then sees the coordinates instead of the window id', () => {
        setLocale('en-US');
        const text = mountCall({
            action: 'click',
            pid: 144544,
            window_id: 67502756,
            x: 640,
            y: 320,
        }).text();
        expect(text).toContain('640, 320');
        expect(text).not.toContain('144544');
    });

    it('user given a drag between two points when reading its activity then sees both endpoints', () => {
        setLocale('en-US');
        const text = mountCall({
            action: 'drag',
            pid: 144544,
            window_id: 67502756,
            from_x: 10,
            from_y: 20,
            to_x: 300,
            to_y: 400,
        }).text();
        expect(text).toContain('10, 20 → 300, 400');
        expect(text).not.toContain('144544');
    });

    it('user given a browser navigation when reading its activity then sees the address', () => {
        setLocale('en-US');
        const text = mountCall({
            action: 'call',
            tool: 'browser_navigate',
            arguments: { url: 'https://example.com/docs' },
        }).text();
        expect(text).toContain('https://example.com/docs');
    });
});
