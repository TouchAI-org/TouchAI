import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import ConversationReadingColumn from '@/views/SearchView/components/ConversationPanel/components/ConversationReadingColumn.vue';

enableAutoUnmount(afterEach);

describe('user reads a conversation with adjustable margins', () => {
    let resize: (available: number) => void;

    beforeEach(() => {
        vi.stubGlobal(
            'ResizeObserver',
            class {
                constructor(callback: ResizeObserverCallback) {
                    resize = (available) =>
                        callback(
                            [{ contentRect: { width: available } } as ResizeObserverEntry],
                            this as ResizeObserver
                        );
                }
                observe() {}
                unobserve() {}
                disconnect() {}
            }
        );
    });

    afterEach(() => vi.unstubAllGlobals());

    async function openColumn(width = 880) {
        const column = mount(ConversationReadingColumn, { props: { width, controls: 'messages' } });
        resize(1744);
        await nextTick();
        return column;
    }

    async function pointer(element: Element, type: string, init: PointerEventInit) {
        element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
        await nextTick();
    }

    it.each([
        [0, -160],
        [1, 160],
    ])(
        'user drags edge %i outward and saves a symmetric width only on release',
        async (index, delta) => {
            const column = await openColumn();
            const handle = column.findAll('[role="separator"]')[index]!;
            const start = { pointerId: 1, button: 0, clientX: 500 };
            Object.assign(handle.element, {
                setPointerCapture: vi.fn(),
                hasPointerCapture: () => false,
            });
            await pointer(handle.element, 'pointerdown', start);
            await pointer(handle.element, 'pointermove', { ...start, clientX: 500 + delta });
            expect(handle.attributes('aria-valuenow')).toBe('1200');
            expect(column.text()).toContain('1200 px');
            expect(column.emitted('commit')).toBeUndefined();
            await pointer(handle.element, 'pointerup', { ...start, clientX: 500 + delta });
            expect(column.emitted('commit')).toEqual([[1200]]);
        }
    );

    it('user cancels a drag without replacing the saved width', async () => {
        const column = await openColumn(1200);
        const handle = column.get('[role="separator"]');
        Object.assign(handle.element, {
            setPointerCapture: vi.fn(),
            hasPointerCapture: () => false,
        });
        await pointer(handle.element, 'pointerdown', { pointerId: 7, button: 0, clientX: 500 });
        await pointer(handle.element, 'pointermove', { pointerId: 7, clientX: 550 });
        await pointer(handle.element, 'pointercancel', { pointerId: 7 });
        expect(handle.attributes('aria-valuenow')).toBe('1200');
        expect(column.emitted('commit')).toBeUndefined();
    });

    it('user adjusts either edge with the keyboard and double-clicks to reset', async () => {
        const column = await openColumn(1200);
        const [left, right] = column.findAll('[role="separator"]');
        await left!.trigger('keydown', { key: 'ArrowLeft' });
        await right!.trigger('keydown', { key: 'ArrowLeft' });
        await right!.trigger('dblclick');
        expect(column.emitted('commit')).toEqual([[1220], [1180], [880]]);
    });

    it('user narrows and reopens the window without losing a wider reading preference', async () => {
        const column = await openColumn(1600);
        resize(1100);
        await nextTick();
        const handle = column.get('[role="separator"]');
        expect(handle.attributes('aria-valuenow')).toBe('1100');
        await handle.trigger('keydown', { key: 'ArrowLeft' });
        resize(574);
        await nextTick();
        expect(column.find('[role="separator"]').exists()).toBe(false);
        resize(1744);
        await nextTick();
        expect(column.get('[role="separator"]').attributes('aria-valuenow')).toBe('1600');
        expect(column.emitted('commit')).toBeUndefined();
    });

    it('user presses Escape during a drag and the original width survives the release', async () => {
        const column = await openColumn(1200);
        const handle = column.get('[role="separator"]');
        Object.assign(handle.element, {
            setPointerCapture: vi.fn(),
            hasPointerCapture: () => true,
            releasePointerCapture: vi.fn(),
        });
        await pointer(handle.element, 'pointerdown', { pointerId: 1, button: 0, clientX: 500 });
        await pointer(handle.element, 'pointermove', { pointerId: 2, clientX: 550 });
        expect(handle.attributes('aria-valuenow')).toBe('1200');
        await pointer(handle.element, 'pointermove', { pointerId: 1, clientX: 550 });
        expect(handle.attributes('aria-valuenow')).toBe('1100');
        await handle.trigger('keydown', { key: 'Escape' });
        await pointer(handle.element, 'pointerup', { pointerId: 1, clientX: 550 });
        expect(handle.attributes('aria-valuenow')).toBe('1200');
        expect(column.emitted('commit')).toBeUndefined();
    });

    it('user can choose the minimum and the largest fitting step with the keyboard', async () => {
        const column = await openColumn();
        const handle = column.get('[role="separator"]');
        await handle.trigger('keydown', { key: 'Home' });
        await handle.trigger('keydown', { key: 'End' });
        expect(column.emitted('commit')).toEqual([[640], [1740]]);
    });
});
