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
});
