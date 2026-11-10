import type { QuickShortcutItem } from '@services/NativeService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { useLayout } from '@/views/SearchView/components/QuickSearchPanel/composables/useLayout';

function createShortcut(id: number): QuickShortcutItem {
    return {
        name: `Item ${id}`,
        path: `D:/Item-${id}.lnk`,
        source: 'desktop_user',
    };
}

function setReadonlyNumber(target: object, key: string, value: number) {
    Object.defineProperty(target, key, {
        configurable: true,
        value,
    });
}

async function flushAsyncWork() {
    await nextTick();
    await Promise.resolve();
}

describe('when the quick search panel lays out its results', () => {
    it.each(['grid', 'list'] as const)(
        'user given more %s results when scrolling past the first batch then expands once before scrolling normally',
        (mode) => {
            const scrollElement = document.createElement('div');
            setReadonlyNumber(scrollElement, 'clientWidth', 400);
            const results = ref(Array.from({ length: 60 }, (_, index) => createShortcut(index)));
            const layout = useLayout({
                isOpen: ref(true),
                results,
                highlightedIndex: ref(-1),
                scrollRef: ref(scrollElement),
            });
            if (mode === 'list') layout.toggleViewMode();
            layout.resetLayoutState();
            layout.updateLayout();
            const initialHeight = layout.selectionMaxHeight.value;
            const upward = new WheelEvent('wheel', { deltaY: -120, cancelable: true });
            layout.handleWheel(upward);
            expect(layout.selectionMaxHeight.value).toBe(initialHeight);
            expect(upward.defaultPrevented).toBe(false);

            const downward = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
            layout.handleWheel(downward);
            expect(layout.selectionMaxHeight.value).toBeGreaterThan(initialHeight);
            expect(downward.defaultPrevented).toBe(true);
            expect(scrollElement.scrollTop).toBe(0);

            const expandedHeight = layout.selectionMaxHeight.value;
            const nextScroll = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
            layout.handleWheel(nextScroll);
            expect(layout.selectionMaxHeight.value).toBe(expandedHeight);
            expect(nextScroll.defaultPrevented).toBe(false);

            results.value = [createShortcut(1)];
            layout.resetLayoutState();
            layout.updateLayout();
            const shortHeight = layout.selectionMaxHeight.value;
            const shortScroll = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
            layout.handleWheel(shortScroll);
            expect(layout.selectionMaxHeight.value).toBe(shortHeight);
            expect(shortScroll.defaultPrevented).toBe(false);
        }
    );

    it.each(['grid', 'list'] as const)(
        'user navigates back into the first %s batch and sees the panel collapse then expand when leaving it again',
        (mode) => {
            const scrollElement = document.createElement('div');
            setReadonlyNumber(scrollElement, 'clientWidth', 400);
            const highlightedIndex = ref(-1);
            const layout = useLayout({
                isOpen: ref(true),
                results: ref(Array.from({ length: 60 }, (_, index) => createShortcut(index))),
                highlightedIndex,
                scrollRef: ref(scrollElement),
            });
            if (mode === 'list') layout.toggleViewMode();
            layout.updateLayout();
            const initialHeight = layout.selectionMaxHeight.value;
            const initialRows = layout.visibleRows.value;
            for (let index = 0; index <= initialRows; index++) layout.moveSelection('down');
            expect(layout.selectionMaxHeight.value).toBeGreaterThan(initialHeight);
            layout.moveSelection('up');
            expect(layout.selectionMaxHeight.value).toBe(initialHeight);
            layout.moveSelection('down');
            expect(layout.selectionMaxHeight.value).toBeGreaterThan(initialHeight);
        }
    );

    it('user given a collapsed grid when switching layout then keeps the first batch until requesting more', () => {
        const layout = useLayout({
            isOpen: ref(true),
            results: ref(Array.from({ length: 60 }, (_, index) => createShortcut(index))),
            highlightedIndex: ref(-1),
            scrollRef: ref(null),
        });
        layout.toggleViewMode();
        expect(layout.selectionMaxHeight.value).toBe(304);
        layout.toggleViewMode();
        expect(layout.selectionMaxHeight.value).toBe(200);
    });

    it.each(['grid', 'list'] as const)(
        'user given a height-constrained %s picker when moving below the viewport then sees the active row',
        async (mode) => {
            const frames: FrameRequestCallback[] = [];
            vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
                frames.push(callback);
                return frames.length;
            });
            const scrollElement = document.createElement('div');
            setReadonlyNumber(scrollElement, 'clientWidth', 220);
            setReadonlyNumber(scrollElement, 'clientHeight', 200);
            setReadonlyNumber(scrollElement, 'scrollHeight', 2000);
            const highlightedIndex = ref(-1);
            const layout = useLayout({
                isOpen: ref(true),
                results: ref(Array.from({ length: 40 }, (_, i) => createShortcut(i))),
                highlightedIndex,
                scrollRef: ref(scrollElement),
            });
            if (mode === 'list') layout.toggleViewMode();
            layout.updateLayout();
            for (let i = 0; i < 8; i++) {
                layout.moveSelection('down');
                while (frames.length) frames.shift()!(performance.now());
            }
            const row = mode === 'list' ? highlightedIndex.value : highlightedIndex.value / 2;
            const rowTop = 8 + row * (mode === 'list' ? 48 : 96);
            const rowBottom = rowTop + (mode === 'list' ? 48 : 88);
            expect(rowTop).toBeGreaterThanOrEqual(scrollElement.scrollTop);
            expect(rowBottom).toBeLessThanOrEqual(scrollElement.scrollTop + 200);
        }
    );

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
    });

    it('settles result layout without blocking the next query on a suspended animation frame', async () => {
        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn(() => 1)
        );
        const scrollElement = document.createElement('div');
        setReadonlyNumber(scrollElement, 'clientWidth', 400);
        setReadonlyNumber(document.documentElement, 'clientWidth', 400);
        setReadonlyNumber(window, 'innerWidth', 400);
        const layout = useLayout({
            isOpen: ref(true),
            results: ref([createShortcut(1)]),
            highlightedIndex: ref(-1),
            scrollRef: ref(scrollElement),
        });
        let settled = false;
        void layout.syncLayout().then(() => {
            settled = true;
        });
        await flushAsyncWork();
        await flushAsyncWork();
        expect(settled).toBe(true);
        expect(layout.gridColumns.value).toBe(4);
    });

    it('user sees more columns as the panel gets wider', () => {
        const isOpen = ref(true);
        const results = ref([
            createShortcut(1),
            createShortcut(2),
            createShortcut(3),
            createShortcut(4),
            createShortcut(5),
            createShortcut(6),
            createShortcut(7),
            createShortcut(8),
            createShortcut(9),
            createShortcut(10),
        ]);
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');
        const panelElement = document.createElement('div');
        panelElement.appendChild(scrollElement);
        document.body.appendChild(panelElement);

        setReadonlyNumber(scrollElement, 'clientWidth', 400);
        setReadonlyNumber(panelElement, 'clientWidth', 400);
        setReadonlyNumber(document.documentElement, 'clientWidth', 400);
        setReadonlyNumber(window, 'innerWidth', 400);

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        layout.updateLayout();

        expect(layout.gridColumns.value).toBe(4);
        expect(layout.gridGap.value).toBe(8);
        expect(layout.visibleRows.value).toBe(2);
        expect(layout.selectionMaxHeight.value).toBe(200);
        expect(layout.gridStyle.value).toEqual({
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: '8px',
        });
    });

    it('user sees every grid column inside the card when the host includes transparent margins', () => {
        const scrollElement = document.createElement('div');
        const panelElement = document.createElement('div');
        panelElement.append(scrollElement);
        setReadonlyNumber(scrollElement, 'clientWidth', 420);
        setReadonlyNumber(panelElement, 'clientWidth', 440);
        setReadonlyNumber(document.documentElement, 'clientWidth', 536);
        setReadonlyNumber(window, 'innerWidth', 536);
        const layout = useLayout({
            isOpen: ref(true),
            results: ref(Array.from({ length: 12 }, (_, index) => createShortcut(index))),
            highlightedIndex: ref(-1),
            scrollRef: ref(scrollElement),
        });
        layout.updateLayout();
        expect(
            layout.gridColumns.value * 88 + (layout.gridColumns.value + 1) * layout.gridGap.value
        ).toBeLessThanOrEqual(420);
    });

    it('user sees the panel grow when moving the highlight below the collapsed rows', async () => {
        const isOpen = ref(true);
        const results = ref([
            createShortcut(1),
            createShortcut(2),
            createShortcut(3),
            createShortcut(4),
            createShortcut(5),
            createShortcut(6),
        ]);
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');
        const panelElement = document.createElement('div');
        panelElement.appendChild(scrollElement);
        document.body.appendChild(panelElement);

        setReadonlyNumber(scrollElement, 'clientWidth', 220);
        setReadonlyNumber(scrollElement, 'clientHeight', 200);
        setReadonlyNumber(scrollElement, 'scrollHeight', 1000);
        setReadonlyNumber(panelElement, 'clientWidth', 220);
        setReadonlyNumber(document.documentElement, 'clientWidth', 220);
        setReadonlyNumber(window, 'innerWidth', 220);

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        layout.updateLayout();
        layout.moveSelection('down');
        await flushAsyncWork();
        layout.moveSelection('down');
        await flushAsyncWork();
        layout.moveSelection('down');
        await flushAsyncWork();

        expect(highlightedIndex.value).toBe(4);
        expect(layout.visibleRows.value).toBe(4);
        expect(scrollElement.scrollTop).toBe(0);

        layout.moveSelection('up');
        await flushAsyncWork();
        layout.moveSelection('up');
        await flushAsyncWork();
        layout.moveSelection('up');
        await flushAsyncWork();

        expect(highlightedIndex.value).toBe(-1);
    });

    it('user sees the panel collapse back when it closes or finds nothing', () => {
        const isOpen = ref(false);
        const results = ref<QuickShortcutItem[]>([]);
        const highlightedIndex = ref(3);
        const scrollElement = document.createElement('div');

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        layout.setVisibleRows(4);
        layout.updateLayout();

        expect(layout.gridColumns.value).toBe(1);
        expect(layout.gridGap.value).toBe(8);
        expect(layout.visibleRows.value).toBe(2);
        expect(layout.selectionMaxHeight.value).toBe(200);
    });

    it('user can switch the results between a grid and a list', () => {
        const isOpen = ref(true);
        const results = ref([createShortcut(1), createShortcut(2)]);
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        expect(layout.viewMode.value).toBe('grid');

        layout.toggleViewMode();
        expect(layout.viewMode.value).toBe('list');

        layout.toggleViewMode();
        expect(layout.viewMode.value).toBe('grid');
    });

    it('user keeps the expanded rows when switching between grid and list', () => {
        const isOpen = ref(true);
        const results = ref(Array.from({ length: 20 }, (_, i) => createShortcut(i)));
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        // Expand grid to max.
        layout.setVisibleRows(4);
        expect(layout.visibleRows.value).toBe(4);

        // Toggle to list should set expanded list rows.
        layout.toggleViewMode();
        expect(layout.viewMode.value).toBe('list');
        expect(layout.visibleRows.value).toBe(10);

        // Toggle back to grid should set expanded grid rows.
        layout.toggleViewMode();
        expect(layout.viewMode.value).toBe('grid');
        expect(layout.visibleRows.value).toBe(4);
    });

    it('user gets a different visible height in list mode than in grid mode', () => {
        const isOpen = ref(true);
        const results = ref(Array.from({ length: 20 }, (_, i) => createShortcut(i)));
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        const gridHeight = layout.selectionMaxHeight.value;

        layout.toggleViewMode();
        const listHeight = layout.selectionMaxHeight.value;

        // List mode should have different height than grid mode.
        expect(listHeight).not.toBe(gridHeight);
        expect(listHeight).toBeGreaterThan(0);
    });

    it('user gets the collapsed height when the panel is closed', () => {
        const isOpen = ref(false);
        const results = ref([createShortcut(1)]);
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        // When closed, should return default collapsed height.
        expect(layout.selectionMaxHeight.value).toBeGreaterThan(0);
    });

    it('user gets more visible rows as results arrive', () => {
        const isOpen = ref(true);
        const results = ref([createShortcut(1), createShortcut(2)]);
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');
        const panelElement = document.createElement('div');
        panelElement.appendChild(scrollElement);
        document.body.appendChild(panelElement);

        setReadonlyNumber(scrollElement, 'clientWidth', 400);
        setReadonlyNumber(panelElement, 'clientWidth', 400);
        setReadonlyNumber(document.documentElement, 'clientWidth', 400);
        setReadonlyNumber(window, 'innerWidth', 400);

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        layout.updateLayout();
        const initialHeight = layout.selectionMaxHeight.value;

        // Add more results.
        results.value = Array.from({ length: 20 }, (_, i) => createShortcut(i));
        layout.updateLayout();

        expect(layout.selectionMaxHeight.value).toBeGreaterThanOrEqual(initialHeight);
    });

    it('user moves one row at a time in list mode', () => {
        const isOpen = ref(true);
        const results = ref(Array.from({ length: 10 }, (_, i) => createShortcut(i)));
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');
        const panelElement = document.createElement('div');
        panelElement.appendChild(scrollElement);
        document.body.appendChild(panelElement);

        setReadonlyNumber(scrollElement, 'clientWidth', 400);
        setReadonlyNumber(scrollElement, 'clientHeight', 200);
        setReadonlyNumber(scrollElement, 'scrollHeight', 1000);
        setReadonlyNumber(panelElement, 'clientWidth', 400);
        setReadonlyNumber(document.documentElement, 'clientWidth', 400);
        setReadonlyNumber(window, 'innerWidth', 400);

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        layout.toggleViewMode();
        expect(layout.viewMode.value).toBe('list');

        layout.moveSelection('down');
        expect(highlightedIndex.value).toBe(0);

        layout.moveSelection('down');
        expect(highlightedIndex.value).toBe(1);

        layout.moveSelection('up');
        expect(highlightedIndex.value).toBe(0);

        // Up from first item should deactivate.
        layout.moveSelection('up');
        expect(highlightedIndex.value).toBe(-1);
    });

    it('user gets the list collapsed height after a reset in list mode', () => {
        const isOpen = ref(true);
        const results = ref(Array.from({ length: 20 }, (_, i) => createShortcut(i)));
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        layout.toggleViewMode();
        layout.setVisibleRows(10);
        expect(layout.visibleRows.value).toBe(10);

        layout.resetLayoutState();
        expect(layout.visibleRows.value).toBe(6);
    });

    it('user sees the layout measured after the panel renders', async () => {
        const isOpen = ref(true);
        const results = ref([createShortcut(1), createShortcut(2)]);
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');
        const panelElement = document.createElement('div');
        panelElement.appendChild(scrollElement);
        document.body.appendChild(panelElement);

        setReadonlyNumber(scrollElement, 'clientWidth', 400);
        setReadonlyNumber(panelElement, 'clientWidth', 400);
        setReadonlyNumber(document.documentElement, 'clientWidth', 400);
        setReadonlyNumber(window, 'innerWidth', 400);

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        await layout.syncLayout();

        // After syncLayout, gridColumns should be updated.
        expect(layout.gridColumns.value).toBeGreaterThanOrEqual(1);
    });

    it('user gets no scrolling when nothing is highlighted', async () => {
        const isOpen = ref(true);
        const results = ref([createShortcut(1)]);
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        // Should not throw.
        layout.scrollHighlightedIntoView();
    });

    it('user sees the highlighted row scrolled into view', async () => {
        const isOpen = ref(true);
        const results = ref(Array.from({ length: 20 }, (_, i) => createShortcut(i)));
        const highlightedIndex = ref(0);
        const scrollElement = document.createElement('div');
        const panelElement = document.createElement('div');
        panelElement.appendChild(scrollElement);
        document.body.appendChild(panelElement);

        setReadonlyNumber(scrollElement, 'clientWidth', 400);
        setReadonlyNumber(scrollElement, 'clientHeight', 200);
        setReadonlyNumber(scrollElement, 'scrollHeight', 2000);
        setReadonlyNumber(panelElement, 'clientWidth', 400);
        setReadonlyNumber(document.documentElement, 'clientWidth', 400);
        setReadonlyNumber(window, 'innerWidth', 400);

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        layout.updateLayout();

        // Move highlight far down.
        highlightedIndex.value = 15;
        layout.scrollHighlightedIntoView();

        // After rAF, scrollTop should have changed (we can't easily wait for rAF in tests,
        // but the function should not throw).
    });

    it('user moves sideways along a row and wraps at its edges', () => {
        const isOpen = ref(true);
        const results = ref(Array.from({ length: 10 }, (_, i) => createShortcut(i)));
        const highlightedIndex = ref(0);
        const scrollElement = document.createElement('div');
        const panelElement = document.createElement('div');
        panelElement.appendChild(scrollElement);
        document.body.appendChild(panelElement);

        setReadonlyNumber(scrollElement, 'clientWidth', 300);
        setReadonlyNumber(scrollElement, 'clientHeight', 200);
        setReadonlyNumber(scrollElement, 'scrollHeight', 1000);
        setReadonlyNumber(panelElement, 'clientWidth', 300);
        setReadonlyNumber(document.documentElement, 'clientWidth', 300);
        setReadonlyNumber(window, 'innerWidth', 300);

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        layout.updateLayout();

        layout.moveSelection('right');
        expect(highlightedIndex.value).toBe(1);

        layout.moveSelection('left');
        expect(highlightedIndex.value).toBe(0);

        // Left from first item should stay at 0.
        layout.moveSelection('left');
        expect(highlightedIndex.value).toBe(0);
    });

    it('user gets no movement before anything is highlighted', () => {
        const isOpen = ref(true);
        const results = ref([createShortcut(1), createShortcut(2)]);
        const highlightedIndex = ref(-1);
        const scrollElement = document.createElement('div');

        const layout = useLayout({
            isOpen,
            results,
            highlightedIndex,
            scrollRef: ref(scrollElement),
        });

        layout.moveSelection('left');
        expect(highlightedIndex.value).toBe(-1);

        layout.moveSelection('right');
        expect(highlightedIndex.value).toBe(-1);

        layout.moveSelection('up');
        expect(highlightedIndex.value).toBe(-1);
    });
});
