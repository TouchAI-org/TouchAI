import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import SearchPanelResizeHandles from '@/views/SearchView/components/SearchPanelResizeHandles/index.vue';

const CURSORS = {
    n: 'ns-resize',
    ne: 'nesw-resize',
    e: 'ew-resize',
    se: 'nwse-resize',
    s: 'ns-resize',
    sw: 'nesw-resize',
    w: 'ew-resize',
    nw: 'nwse-resize',
} as const;

describe('SearchPanelResizeHandles', () => {
    it('renders eight stable hit targets with standard resize cursors', () => {
        const wrapper = mount(SearchPanelResizeHandles, { props: { enabled: true } });

        for (const [direction, cursor] of Object.entries(CURSORS)) {
            const handle = wrapper.get(`[data-resize-direction="${direction}"]`);
            expect(handle.attributes('style')).toContain(`cursor: ${cursor}`);
        }
        expect(wrapper.findAll('[data-resize-direction]')).toHaveLength(8);
    });

    it('emits the requested direction without allowing panel drag to start', async () => {
        const wrapper = mount(SearchPanelResizeHandles, { props: { enabled: true } });
        const parentPointerDown = vi.fn();
        wrapper.element.parentElement?.addEventListener('pointerdown', parentPointerDown);

        const event = new MouseEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 800,
            clientY: 500,
        });
        Object.defineProperty(event, 'pointerId', { value: 7 });
        wrapper.get('[data-resize-direction="se"]').element.dispatchEvent(event);

        expect(wrapper.emitted('resize-start')?.[0]?.[0]).toBe('se');
        expect(parentPointerDown).not.toHaveBeenCalled();
    });

    it('removes every resize hit target when disabled', () => {
        const wrapper = mount(SearchPanelResizeHandles, { props: { enabled: false } });

        expect(wrapper.find('[data-testid="search-panel-resize-handles"]').exists()).toBe(false);
    });
});
