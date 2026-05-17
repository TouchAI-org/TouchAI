import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';

const {
    startDraggingMock,
    isBlankEditorAreaTargetMock,
    isSearchTagDomTargetMock,
    resolveMouseEventTargetMock,
} = vi.hoisted(() => ({
    startDraggingMock: vi.fn(),
    isBlankEditorAreaTargetMock: vi.fn(),
    isSearchTagDomTargetMock: vi.fn(),
    resolveMouseEventTargetMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        startDragging: startDraggingMock,
    }),
}));

vi.mock('@/views/SearchView/components/SearchBar/utils/tiptap', () => ({
    isBlankEditorAreaTarget: isBlankEditorAreaTargetMock,
    isSearchTagDomTarget: isSearchTagDomTargetMock,
    resolveMouseEventTarget: resolveMouseEventTargetMock,
}));

import { useDragging } from '@/views/SearchView/components/SearchBar/composables/useDragging';

function createEditor(
    options: {
        isEmpty?: boolean;
        posAtCoords?: { pos: number } | null;
        coordsAtPos?: {
            left: number;
            right: number;
            top: number;
            bottom: number;
        };
    } = {}
) {
    return {
        isEmpty: options.isEmpty ?? false,
        view: {
            posAtCoords: vi.fn(() => options.posAtCoords ?? { pos: 1 }),
            coordsAtPos: vi.fn(
                () =>
                    options.coordsAtPos ?? {
                        left: 100,
                        right: 120,
                        top: 100,
                        bottom: 120,
                    }
            ),
        },
    };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

function asMouseEvent(event: Partial<MouseEvent>): MouseEvent {
    return event as unknown as MouseEvent;
}

describe('useDragging', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        startDraggingMock.mockResolvedValue(undefined);
        isBlankEditorAreaTargetMock.mockReturnValue(false);
        isSearchTagDomTargetMock.mockReturnValue(false);
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('starts window dragging from the empty container surface and ignores logo-area clicks', async () => {
        const emitDragStart = vi.fn();
        const emitDragEnd = vi.fn();
        const dragging = useDragging({
            editor: shallowRef(null),
            emitDragStart,
            emitDragEnd,
        });
        const container = document.createElement('div');
        const logoContainer = document.createElement('div');
        logoContainer.className = 'logo-container';
        const logoChild = document.createElement('span');
        logoContainer.appendChild(logoChild);
        container.appendChild(logoContainer);

        await dragging.handleContainerMouseDown(
            asMouseEvent({
                target: logoChild,
                currentTarget: container,
            })
        );
        expect(startDraggingMock).not.toHaveBeenCalled();

        await dragging.handleContainerMouseDown(
            asMouseEvent({
                target: container,
                currentTarget: container,
            })
        );
        await flushAsyncWork();
        await vi.advanceTimersByTimeAsync(100);

        expect(emitDragStart).toHaveBeenCalledTimes(1);
        expect(startDraggingMock).toHaveBeenCalledTimes(1);
        expect(emitDragEnd).toHaveBeenCalledTimes(1);
    });

    it('starts a drag after crossing the editor drag threshold and suppresses the next click once', async () => {
        const emitDragStart = vi.fn();
        const emitDragEnd = vi.fn();
        const target = document.createElement('div');
        resolveMouseEventTargetMock.mockReturnValue(target);
        const dragging = useDragging({
            editor: shallowRef(createEditor({ isEmpty: true }) as never),
            emitDragStart,
            emitDragEnd,
        });

        dragging.handleEditorMouseDown(
            new MouseEvent('mousedown', {
                button: 0,
                clientX: 10,
                clientY: 10,
            })
        );

        window.dispatchEvent(
            new MouseEvent('mousemove', {
                clientX: 20,
                clientY: 20,
            })
        );
        await flushAsyncWork();

        expect(startDraggingMock).toHaveBeenCalledTimes(1);
        expect(dragging.consumeEditorClickAfterDrag()).toBe(true);
        expect(dragging.consumeEditorClickAfterDrag()).toBe(false);
    });

    it('does not treat blank-area clicks near selectable text as a window drag gesture', async () => {
        const target = document.createElement('div');
        resolveMouseEventTargetMock.mockReturnValue(target);
        isBlankEditorAreaTargetMock.mockReturnValue(true);
        const dragging = useDragging({
            editor: shallowRef(
                createEditor({
                    isEmpty: false,
                    posAtCoords: { pos: 2 },
                    coordsAtPos: {
                        left: 100,
                        right: 120,
                        top: 100,
                        bottom: 120,
                    },
                }) as never
            ),
            emitDragStart: vi.fn(),
            emitDragEnd: vi.fn(),
        });

        dragging.handleEditorMouseDown(
            new MouseEvent('mousedown', {
                button: 0,
                clientX: 110,
                clientY: 110,
            })
        );

        window.dispatchEvent(
            new MouseEvent('mousemove', {
                clientX: 130,
                clientY: 130,
            })
        );
        await flushAsyncWork();

        expect(startDraggingMock).not.toHaveBeenCalled();
    });

    it('clears the deferred click-suppression state when the composable is reset', async () => {
        const target = document.createElement('div');
        resolveMouseEventTargetMock.mockReturnValue(target);
        const dragging = useDragging({
            editor: shallowRef(createEditor({ isEmpty: true }) as never),
            emitDragStart: vi.fn(),
            emitDragEnd: vi.fn(),
        });

        dragging.handleEditorMouseDown(
            new MouseEvent('mousedown', {
                button: 0,
                clientX: 5,
                clientY: 5,
            })
        );

        window.dispatchEvent(
            new MouseEvent('mousemove', {
                clientX: 20,
                clientY: 20,
            })
        );
        await flushAsyncWork();

        dragging.clearEditorSelectionDragState();

        expect(dragging.consumeEditorClickAfterDrag()).toBe(false);
    });
});
