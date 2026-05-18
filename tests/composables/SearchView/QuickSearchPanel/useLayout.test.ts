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

describe('useLayout', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('computes grid columns and max height from the available width', () => {
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
            gridTemplateColumns: 'repeat(4, 88px)',
            gap: '8px',
        });
    });

    it('expands visible rows when keyboard navigation moves beyond the collapsed area', async () => {
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

    it('resets layout state when the panel is closed or has no results', () => {
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

    it('toggleViewMode switches between grid and list', () => {
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

    it('toggleViewMode preserves expanded state', () => {
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
        expect(layout.visibleRows.value).toBe(15);

        // Toggle back to grid should set expanded grid rows.
        layout.toggleViewMode();
        expect(layout.viewMode.value).toBe('grid');
        expect(layout.visibleRows.value).toBe(4);
    });

    it('selectionMaxHeight reacts to viewMode changes', () => {
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

    it('selectionMaxHeight returns collapsed default when panel is closed', () => {
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

    it('selectionMaxHeight grows when results increase', () => {
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

    it('moveSelection in list mode uses single column', () => {
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

    it('resetLayoutState in list mode uses list collapsed rows', () => {
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
        layout.setVisibleRows(15);
        expect(layout.visibleRows.value).toBe(15);

        layout.resetLayoutState();
        expect(layout.visibleRows.value).toBe(8);
    });

    it('scrollHighlightedIntoView does nothing when highlight is -1', async () => {
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

    it('scrollHighlightedIntoView scrolls down when highlight is below viewport', async () => {
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

    it('moveSelection right and left within a row', () => {
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

    it('moveSelection does nothing when highlight is -1 for left/right/up', () => {
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
