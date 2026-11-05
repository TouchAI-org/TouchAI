import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { nativeStartDraggingMock } = vi.hoisted(() => ({
    nativeStartDraggingMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        startDragging: nativeStartDraggingMock,
    }),
}));

vi.mock('@/i18n', () => ({
    t: (key: string) => key,
}));

import ConversationToolbar from '@/views/SearchView/components/ConversationPanel/components/ConversationToolbar.vue';

describe('ConversationToolbar dragging', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nativeStartDraggingMock.mockResolvedValue(undefined);
    });

    it('uses the search-panel drag strategy when one is provided', async () => {
        const startDragging = vi.fn().mockResolvedValue(undefined);
        const wrapper = mount(ConversationToolbar, {
            props: {
                isPinned: false,
                isMaximized: false,
                historyOpen: false,
                startDragging,
            },
            global: {
                stubs: {
                    AppIcon: true,
                },
            },
        });

        await wrapper.get('.toolbar-fade-overlay').trigger('mousedown', {
            button: 0,
            clientX: 500,
            clientY: 200,
        });

        expect(startDragging).toHaveBeenCalledTimes(1);
        expect(startDragging).toHaveBeenCalledWith(expect.any(MouseEvent));
        expect(nativeStartDraggingMock).not.toHaveBeenCalled();
        expect(wrapper.emitted('dragEnd')).toHaveLength(1);
    });
});
