import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResultItem, ResultPanel } from '@/components/ui/result-panel';

enableAutoUnmount(afterEach);

describe('given a result surface receives content from its caller', () => {
    it('user given a growing result viewport after selecting the first choice then keeps that choice fully visible', async () => {
        class ResizeObserverStub {
            static callbacks: ResizeObserverCallback[] = [];

            private readonly callback: ResizeObserverCallback;

            constructor(callback: ResizeObserverCallback) {
                this.callback = callback;
                ResizeObserverStub.callbacks.push(callback);
            }

            disconnect() {}

            observe() {}

            unobserve() {}

            trigger() {
                this.callback([], this as unknown as ResizeObserver);
            }
        }
        vi.stubGlobal('ResizeObserver', ResizeObserverStub);
        const wrapper = mount(ResultPanel, {
            attachTo: document.body,
            props: { listId: 'growing-choices', viewportPadding: 8 },
            slots: { default: '<button id="first-choice" role="option">First choice</button>' },
        });
        const viewport = wrapper.get<HTMLElement>('[role="listbox"]').element;
        const row = wrapper.get<HTMLElement>('[role="option"]').element;
        let viewportHeight = 80;
        Object.defineProperties(viewport, {
            clientHeight: { configurable: true, get: () => viewportHeight },
            scrollHeight: { value: 1000 },
            getBoundingClientRect: { value: () => new DOMRect(0, 100, 400, viewportHeight) },
        });
        Object.defineProperty(row, 'getBoundingClientRect', {
            value: () => new DOMRect(8, 108 - viewport.scrollTop, 384, 88),
        });

        await wrapper.setProps({ activeItemId: 'first-choice' });
        expect(viewport.scrollTop).toBe(24);

        viewportHeight = 200;
        ResizeObserverStub.callbacks.forEach((callback) => callback([], {} as ResizeObserver));
        await wrapper.vm.$nextTick();

        expect(viewport.scrollTop).toBe(0);
    });

    it('user given an offscreen active choice when navigating then scrolls only the result viewport to reveal it', async () => {
        const wrapper = mount(ResultPanel, {
            attachTo: document.body,
            props: { listId: 'scroll-choices', viewportPadding: 8 },
            slots: { default: '<button id="last-choice" role="option">Last choice</button>' },
        });
        const viewport = wrapper.get<HTMLElement>('[role="listbox"]').element;
        const row = wrapper.get<HTMLElement>('[role="option"]').element;
        Object.defineProperties(viewport, {
            clientHeight: { value: 200 },
            scrollHeight: { value: 1000 },
            getBoundingClientRect: { value: () => new DOMRect(0, 100, 400, 200) },
        });
        Object.defineProperty(row, 'getBoundingClientRect', {
            value: () => new DOMRect(8, 708 - viewport.scrollTop, 384, 48),
        });
        wrapper.element.scrollTop = 17;
        await wrapper.setProps({ activeItemId: 'last-choice' });
        expect(viewport.scrollTop).toBeGreaterThan(0);
        expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(292);
        expect(wrapper.element.scrollTop).toBe(17);
    });

    it('user given a floating picker when browsing results then sees only choices without the shortcut footer', () => {
        const wrapper = mount(ResultPanel, {
            props: {
                floating: true,
                listId: 'floating-choices',
                status: '12 results',
                shortcuts: [{ keys: ['Tab', 'Enter'], label: 'Insert' }],
                busy: true,
            },
            slots: { default: '<button role="option">A choice</button>' },
        });
        expect(wrapper.get('[role="option"]').text()).toBe('A choice');
        expect(wrapper.get('[role="listbox"]').attributes('aria-busy')).toBe('true');
        expect(wrapper.find('[data-slot="result-panel-footer"]').exists()).toBe(false);
    });

    it('user sees the supplied results and status without a search service', async () => {
        const wrapper = mount(ResultPanel, {
            props: { listId: 'choices', listLabel: 'Available choices', status: 'Tab to select' },
            slots: {
                default: '<button role="option">A choice</button>',
                actions: '<button>Change view</button>',
            },
        });

        expect(wrapper.get('[role="listbox"]').attributes('aria-label')).toBe('Available choices');
        expect(wrapper.get('[role="option"]').text()).toBe('A choice');
        expect(wrapper.text()).toContain('Tab to select');
        expect(wrapper.text()).toContain('Change view');
        await wrapper.get('[role="listbox"]').trigger('scroll');
        expect(wrapper.emitted('scroll')).toHaveLength(1);
    });

    it('user sees loading, failure, and recovered results in the same surface', async () => {
        const wrapper = mount(ResultPanel, {
            props: { listId: 'choices', state: { kind: 'loading', message: 'Loading choices' } },
            slots: { default: '<button role="option">A choice</button>' },
        });

        expect(wrapper.get('[role="listbox"]').attributes('aria-busy')).toBe('true');
        expect(wrapper.get('[role="status"]').text()).toBe('Loading choices');
        expect(wrapper.find('[role="option"]').exists()).toBe(false);
        await wrapper.setProps({ state: { kind: 'error', message: 'Choices unavailable' } });
        expect(wrapper.get('[role="alert"]').text()).toBe('Choices unavailable');
        await wrapper.setProps({ state: { kind: 'empty', message: 'No choices' } });
        expect(wrapper.get('[role="status"]').text()).toBe('No choices');
        await wrapper.setProps({ state: null });
        expect(wrapper.find('[role="status"]').exists()).toBe(false);
        expect(wrapper.get('[role="option"]').text()).toBe('A choice');
    });

    it('user reads each available keyboard action beside its own keys without losing input focus', () => {
        const wrapper = mount(ResultPanel, {
            props: {
                preserveFocus: true,
                shortcuts: [
                    { keys: ['↑', '↓'], label: 'Navigate' },
                    { keys: ['Enter', 'Tab'], separator: '/', label: 'Insert' },
                    { keys: ['Esc'], label: 'Close' },
                ],
            },
        });

        const footer = wrapper.get('[data-slot="result-panel-footer"]');
        expect(footer.findAll('kbd').map((key) => key.text())).toEqual([
            '↑',
            '↓',
            'Enter',
            'Tab',
            'Esc',
        ]);
        expect(footer.text()).toContain('Navigate');
        expect(footer.text()).toContain('Insert');
        expect(footer.text()).toContain('Close');
        const pointerDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        footer.element.dispatchEvent(pointerDown);
        expect(pointerDown.defaultPrevented).toBe(true);
    });

    it('user keeps reading the existing choices while a refresh is announced as busy', async () => {
        const wrapper = mount(ResultPanel, {
            props: { listId: 'choices', busy: true },
            slots: { default: '<button role="option">A choice</button>' },
        });

        expect(wrapper.get('[role="listbox"]').attributes('aria-busy')).toBe('true');
        expect(wrapper.get('[role="option"]').text()).toBe('A choice');
        await wrapper.setProps({ busy: false });
        expect(wrapper.get('[role="listbox"]').attributes('aria-busy')).toBe('false');
        expect(wrapper.find('[data-slot="result-panel-footer"]').exists()).toBe(false);
    });

    it('user keeps the active editor selection while choosing from an attached result surface', async () => {
        const wrapper = mount(ResultPanel, { props: { preserveFocus: true } });
        const pointerDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        wrapper.element.dispatchEvent(pointerDown);
        expect(pointerDown.defaultPrevented).toBe(true);

        await wrapper.setProps({ preserveFocus: false });
        const ordinaryPointerDown = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
        });
        wrapper.element.dispatchEvent(ordinaryPointerDown);
        expect(ordinaryPointerDown.defaultPrevented).toBe(false);
    });

    it('user can return to the input by clicking empty space without activating a result', async () => {
        const wrapper = mount(ResultPanel, {
            props: { listId: 'choices' },
            slots: { default: '<button role="option">A choice</button>' },
        });
        await wrapper.trigger('click');
        expect(wrapper.emitted('blankClick')).toHaveLength(1);
        await wrapper.get('[role="listbox"]').trigger('click');
        expect(wrapper.emitted('blankClick')).toHaveLength(2);
        await wrapper.get('[role="option"]').trigger('click');
        expect(wrapper.emitted('blankClick')).toHaveLength(2);
    });
});

describe('given a result row receives a label and caller-owned action', () => {
    it('user selects a result with its custom icon and matching text intact', async () => {
        const wrapper = mount(ResultItem, {
            props: {
                label: 'Summary',
                description: 'A concise summary',
                segments: [
                    { text: 'Sum', matched: true },
                    { text: 'mary', matched: false },
                ],
                highlighted: true,
            },
            slots: { leading: '<span aria-label="Document">D</span>' },
        });

        expect(wrapper.text()).toContain('Summary');
        expect(wrapper.text()).toContain('A concise summary');
        expect(wrapper.get('[aria-label="Document"]').text()).toBe('D');
        await wrapper.trigger('click');
        expect(wrapper.emitted('click')).toHaveLength(1);
        await wrapper.trigger('contextmenu');
        expect(wrapper.emitted('contextmenu')).toHaveLength(1);
    });

    it('user cannot activate an unavailable result', async () => {
        const wrapper = mount(ResultItem, {
            props: { label: 'Unavailable', disabled: true },
        });
        expect(wrapper.text()).toBe('Unavailable');
        expect(wrapper.attributes('disabled')).toBeDefined();
        await wrapper.trigger('click');
        expect(wrapper.emitted('click')).toBeUndefined();
    });

    it('user changes from a list to tiles while keeping the same result and action', async () => {
        const wrapper = mount(ResultItem, {
            props: { label: 'Report', description: 'D:/Reports/Report.md' },
        });
        expect(wrapper.text()).toContain('D:/Reports/Report.md');
        await wrapper.setProps({ layout: 'grid' });
        expect(wrapper.text()).toBe('Report');
        await wrapper.trigger('click');
        expect(wrapper.emitted('click')).toHaveLength(1);
        await wrapper.setProps({ layout: 'list' });
        expect(wrapper.text()).toContain('D:/Reports/Report.md');
    });
});
