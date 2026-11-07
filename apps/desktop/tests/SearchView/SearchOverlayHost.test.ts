import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import SearchOverlayHost from '@/views/SearchView/components/SearchOverlayHost/index.vue';

function rect(left: number, top: number, width = 40, height = 20): DOMRect {
    return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
    } as DOMRect;
}

describe('SearchOverlayHost', () => {
    let nextFrameId: number;
    let frameCallbacks: Map<number, FrameRequestCallback>;
    let observers: Array<{
        observe: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
    }>;

    const runFrames = () => {
        const callbacks = [...frameCallbacks.values()];
        frameCallbacks.clear();
        callbacks.forEach((callback) => callback(0));
    };

    beforeEach(() => {
        nextFrameId = 1;
        frameCallbacks = new Map();
        observers = [];

        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn((callback: FrameRequestCallback) => {
                const id = nextFrameId++;
                frameCallbacks.set(id, callback);
                return id;
            })
        );
        vi.stubGlobal(
            'cancelAnimationFrame',
            vi.fn((id: number) => {
                frameCallbacks.delete(id);
            })
        );
        vi.stubGlobal(
            'ResizeObserver',
            vi.fn(function () {
                const observer = {
                    observe: vi.fn(),
                    disconnect: vi.fn(),
                };
                observers.push(observer);
                return observer;
            })
        );
        vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(800);
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('emits only when a pointer down occurs outside the overlay and anchor', async () => {
        const anchor = document.createElement('button');
        const outside = document.createElement('div');
        document.body.append(anchor, outside);
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            attachTo: document.body,
            props: { open: true, anchor },
            slots: { default: '<button data-inside>inside</button>' },
        });
        await nextTick();

        anchor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        wrapper
            .get('[data-inside]')
            .element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        expect(wrapper.emitted('outsideClick')).toBeUndefined();

        outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        expect(wrapper.emitted('outsideClick')).toHaveLength(1);

        wrapper.unmount();
    });

    it('re-observes a replacement anchor and refreshes after explicit movement', async () => {
        const firstAnchor = document.createElement('button');
        const secondAnchor = document.createElement('button');
        const firstRect = vi
            .spyOn(firstAnchor, 'getBoundingClientRect')
            .mockReturnValue(rect(20, 20));
        const secondRect = vi
            .spyOn(secondAnchor, 'getBoundingClientRect')
            .mockReturnValue(rect(200, 100));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor: firstAnchor },
            slots: { default: '<div style="width: 80px; height: 40px">overlay</div>' },
        });
        await nextTick();
        runFrames();
        expect(firstRect).toHaveBeenCalled();

        await wrapper.setProps({ anchor: secondAnchor });
        await nextTick();
        runFrames();
        expect(observers[0]?.disconnect).toHaveBeenCalled();
        expect(observers[observers.length - 1]?.observe).toHaveBeenCalledWith(secondAnchor);
        expect(secondRect).toHaveBeenCalled();

        secondRect.mockReturnValue(rect(260, 140));
        const callsBeforeRefresh = secondRect.mock.calls.length;
        await (wrapper.vm as unknown as { refreshPosition: () => Promise<void> }).refreshPosition();
        expect(secondRect.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);

        wrapper.unmount();
    });

    it('separates overlay positioning from the interactive anchor', async () => {
        const positionAnchor = document.createElement('main');
        const interactiveAnchor = document.createElement('button');
        const panelOutsideTrigger = document.createElement('div');
        positionAnchor.append(interactiveAnchor, panelOutsideTrigger);
        document.body.append(positionAnchor);
        vi.spyOn(positionAnchor, 'getBoundingClientRect').mockReturnValue(rect(20, 50, 750, 60));
        vi.spyOn(interactiveAnchor, 'getBoundingClientRect').mockReturnValue(rect(220, 70, 40, 20));

        const wrapper = mount(SearchOverlayHost, {
            attachTo: document.body,
            props: {
                open: true,
                anchor: interactiveAnchor,
                positionAnchor,
                gap: 5,
                viewportPadding: 0,
            },
            slots: { default: '<div style="width: 80px; height: 40px">overlay</div>' },
        });
        await nextTick();
        await (
            wrapper.vm as unknown as {
                refreshPosition: () => Promise<void>;
            }
        ).refreshPosition();
        runFrames();
        await nextTick();
        runFrames();

        expect(wrapper.get('[data-search-overlay-host="true"]').attributes('style')).toContain(
            'left: 20px'
        );
        expect(observers[observers.length - 1]?.observe).toHaveBeenCalledWith(positionAnchor);

        panelOutsideTrigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        expect(wrapper.emitted('outsideClick')).toHaveLength(1);

        wrapper.unmount();
    });

    it('observes the page layout target so translated anchors are repositioned', async () => {
        const anchor = document.createElement('button');
        const layoutTarget = document.createElement('main');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor, layoutTarget },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();

        expect(observers[observers.length - 1]?.observe).toHaveBeenCalledWith(anchor);
        expect(observers[observers.length - 1]?.observe).toHaveBeenCalledWith(layoutTarget);

        wrapper.unmount();
    });

    it('user sees the picker aligned to the surface with the reported position matching its visible bounds', async () => {
        const anchor = document.createElement('button');
        const surface = document.createElement('main');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(64, 400, 32, 32));
        vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(48, 64, 750, 400));
        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor, leftAlignElement: surface },
            slots: { default: '<div>models</div>' },
        });
        await nextTick();
        await (wrapper.vm as unknown as { refreshPosition: () => Promise<void> }).refreshPosition();
        const positions = wrapper.emitted('positioned')!;
        const positioned = positions[positions.length - 1]![0] as { left: number };
        expect(positioned.left).toBe(48);
        expect(wrapper.get('[data-search-overlay-host=true]').attributes('style')).toContain(
            'left: 48px'
        );
        wrapper.unmount();
    });

    it('keeps the region envelope outside the transformed motion layer', async () => {
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();

        const regionEnvelope = wrapper.get('[data-search-overlay-host="true"]');
        const motionLayer = regionEnvelope.get('[data-search-overlay-motion="true"]');
        expect(motionLayer.element.parentElement).toBe(regionEnvelope.element);

        wrapper.unmount();
    });

    it('user opens the overlay, then sees its final state after positioning and the enter frame', async () => {
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();

        expect(
            wrapper.get('[data-search-overlay-host="true"]').attributes('data-motion-state')
        ).toBe('entering');
        expect(
            wrapper.get('[data-search-overlay-motion="true"]').attributes('data-motion-state')
        ).toBe('entering');

        for (let tick = 0; tick < 4; tick += 1) {
            await nextTick();
            runFrames();
        }
        await nextTick();

        expect(
            wrapper.get('[data-search-overlay-host="true"]').attributes('data-motion-state')
        ).toBe('open');
        expect(
            wrapper.get('[data-search-overlay-motion="true"]').attributes('data-motion-state')
        ).toBe('open');

        wrapper.unmount();
    });

    it('keeps the overlay hidden until the host viewport has settled', async () => {
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, reveal: false, anchor },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();
        runFrames();

        expect(wrapper.get('[data-search-overlay-host="true"]').attributes('style')).toContain(
            'visibility: hidden'
        );

        await wrapper.setProps({ reveal: true });
        await nextTick();
        runFrames();
        await nextTick();

        expect(wrapper.get('[data-search-overlay-host="true"]').attributes('style')).toContain(
            'visibility: visible'
        );

        wrapper.unmount();
    });

    it('user opens a prepared overlay, then its filter receives focus only after the DOM is visible', async () => {
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));
        let focusVisibility: string | undefined;
        const wrapper = mount(SearchOverlayHost, {
            attachTo: document.body,
            props: {
                open: true,
                reveal: false,
                anchor,
                onRevealed: () => {
                    const field = wrapper.get('input').element as HTMLInputElement;
                    focusVisibility = getComputedStyle(field).visibility;
                    field.focus();
                },
            },
            slots: { default: '<input aria-label="Filter" />' },
        });
        await nextTick();
        runFrames();
        expect(focusVisibility).toBeUndefined();

        await wrapper.setProps({ reveal: true });
        for (let tick = 0; tick < 4; tick += 1) {
            await nextTick();
            runFrames();
        }

        expect(focusVisibility).toBe('visible');
        expect(document.activeElement).toBe(wrapper.get('input').element);
        wrapper.unmount();
    });

    it('user receives overlay keyboard focus when its visible entrance starts', async () => {
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));
        const wrapper = mount(SearchOverlayHost, {
            attachTo: document.body,
            props: {
                open: true,
                reveal: false,
                anchor,
                onRevealed: () => (wrapper.get('input').element as HTMLInputElement).focus(),
            },
            slots: { default: '<input aria-label="Filter" />' },
        });
        await wrapper.setProps({ reveal: true });
        for (let tick = 0; tick < 6; tick += 1) await nextTick();

        expect(document.activeElement).not.toBe(wrapper.get('input').element);
        expect(wrapper.emitted('revealed')).toBeUndefined();

        runFrames();
        await nextTick();
        expect(document.activeElement).toBe(wrapper.get('input').element);
        expect(wrapper.emitted('revealed')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user closing the overlay before its entrance cannot lose focus to the cancelled popup', async () => {
        const anchor = document.createElement('button');
        document.body.append(anchor);
        anchor.focus();
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));
        const wrapper = mount(SearchOverlayHost, {
            attachTo: document.body,
            props: {
                open: true,
                anchor,
                onRevealed: () => (wrapper.get('input').element as HTMLInputElement).focus(),
            },
            slots: { default: '<input aria-label="Filter" />' },
        });
        for (let tick = 0; tick < 6; tick += 1) await nextTick();
        await wrapper.setProps({ open: false });
        runFrames();
        await nextTick();

        expect(document.activeElement).toBe(anchor);
        expect(wrapper.emitted('revealed')).toBeUndefined();
        wrapper.unmount();
    });

    it('disconnects observation and cancels pending positioning on unmount', async () => {
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));
        const removeEventListener = vi.spyOn(document, 'removeEventListener');

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();
        expect(frameCallbacks.size).toBeGreaterThan(0);

        wrapper.unmount();

        expect(observers[observers.length - 1]?.disconnect).toHaveBeenCalled();
        expect(cancelAnimationFrame).toHaveBeenCalled();
        expect(frameCallbacks.size).toBe(0);
        expect(removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    });

    it('keeps the region envelope through the close transition and releases it after transitionend', async () => {
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor },
            slots: { default: '<div>overlay</div>' },
            global: { stubs: { transition: false } },
        });
        await nextTick();
        runFrames();
        expect(wrapper.find('[data-search-overlay-host="true"]').exists()).toBe(true);

        await wrapper.setProps({ open: false });
        await nextTick();

        const regionEnvelope = wrapper.find('[data-search-overlay-host="true"]');
        expect(regionEnvelope.exists()).toBe(true);
        expect(regionEnvelope.attributes('data-motion-state')).toBe('closing');
        expect(wrapper.emitted('afterLeave')).toBeUndefined();

        regionEnvelope
            .get('[data-search-overlay-motion="true"]')
            .element.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true }));
        await nextTick();

        expect(wrapper.find('[data-search-overlay-host="true"]').exists()).toBe(false);
        const regionEvents = wrapper.emitted('regionChange') ?? [];
        expect(regionEvents[regionEvents.length - 1]).toEqual([null]);
        expect(wrapper.emitted('afterLeave')).toHaveLength(1);

        wrapper.unmount();
    });

    it('releases the closing overlay after the timeout fallback', async () => {
        vi.useFakeTimers();
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();
        runFrames();

        await wrapper.setProps({ open: false });
        await nextTick();
        expect(wrapper.find('[data-search-overlay-host=true]').exists()).toBe(true);

        await vi.advanceTimersByTimeAsync(149);
        expect(wrapper.find('[data-search-overlay-host=true]').exists()).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        await nextTick();
        expect(wrapper.find('[data-search-overlay-host=true]').exists()).toBe(false);
        expect(wrapper.emitted('afterLeave')).toHaveLength(1);

        wrapper.unmount();
    });

    it('releases the closing overlay on the next frame when reduced motion is preferred', async () => {
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => ({ matches: true }))
        );
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();
        runFrames();

        await wrapper.setProps({ open: false });
        await nextTick();
        expect(wrapper.find('[data-search-overlay-host=true]').exists()).toBe(true);

        runFrames();
        await nextTick();
        expect(wrapper.find('[data-search-overlay-host=true]').exists()).toBe(false);
        expect(wrapper.emitted('afterLeave')).toHaveLength(1);

        wrapper.unmount();
    });

    it('keeps a reopened overlay mounted after the previous close timeout expires', async () => {
        vi.useFakeTimers();
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();
        runFrames();

        await wrapper.setProps({ open: false });
        await nextTick();
        await wrapper.setProps({ open: true });
        await nextTick();

        await vi.advanceTimersByTimeAsync(150);
        runFrames();
        runFrames();
        await nextTick();

        const regionEnvelope = wrapper.find('[data-search-overlay-host=true]');
        expect(regionEnvelope.exists()).toBe(true);
        expect(regionEnvelope.attributes('data-motion-state')).toBe('open');
        expect(wrapper.emitted('afterLeave')).toBeUndefined();

        wrapper.unmount();
    });

    it('keeps the enter transition on the motion layer', async () => {
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();

        expect(
            (wrapper.get('[data-search-overlay-motion="true"]').element as HTMLElement).style
                .transition
        ).not.toBe('none');

        wrapper.unmount();
    });

    it('ignores transition events from an overlay instance that has already left', async () => {
        const anchor = document.createElement('button');
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(20, 20));

        const wrapper = mount(SearchOverlayHost, {
            props: { open: true, anchor },
            slots: { default: '<div>overlay</div>' },
        });
        await nextTick();
        runFrames();

        await wrapper.setProps({ open: false });
        await nextTick();
        const staleMotionElement = wrapper.get('[data-search-overlay-motion=true]').element;
        staleMotionElement.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true }));
        await nextTick();
        expect(wrapper.find('[data-search-overlay-host=true]').exists()).toBe(false);

        await wrapper.setProps({ open: true });
        await nextTick();
        runFrames();
        runFrames();
        staleMotionElement.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true }));
        await nextTick();

        expect(wrapper.find('[data-search-overlay-host=true]').exists()).toBe(true);
        expect(wrapper.emitted('afterLeave')).toHaveLength(1);

        wrapper.unmount();
    });
});
