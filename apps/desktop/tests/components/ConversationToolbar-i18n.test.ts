import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import ConversationToolbar from '@/views/SearchView/components/ConversationPanel/components/ConversationToolbar.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        startDragging: vi.fn(),
    }),
}));

interface ToolbarProps {
    isPinned: boolean;
    isMaximized: boolean;
    historyOpen: boolean;
    canPin: boolean;
    disabled: boolean;
}

function mountToolbar(overrides: Partial<ToolbarProps> = {}) {
    return mount(ConversationToolbar, {
        props: {
            isPinned: false,
            isMaximized: false,
            historyOpen: false,
            canPin: true,
            disabled: false,
            ...overrides,
        },
    });
}

describe('ConversationToolbar i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('localizes toolbar accessibility labels in English', async () => {
        setLocale('en-US');

        const wrapper = mountToolbar();
        const buttons = wrapper.findAll('button');

        expect(buttons.map((button) => button.attributes('aria-label'))).toEqual([
            'New session',
            'Open session history',
            'Maximize window',
            'Keep window on top',
        ]);

        await wrapper.setProps({ isMaximized: true });

        expect(wrapper.findAll('button')[2]?.attributes('aria-label')).toBe('Restore window');
    });
});
