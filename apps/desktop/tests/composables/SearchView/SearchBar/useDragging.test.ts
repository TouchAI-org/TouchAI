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
        commands: { focus: vi.fn() },
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

describe('given the search input separates clicks from window dragging', () => {
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

    it('user moves the window when dragging empty space but not from the logo', async () => {
        const emitDragStart = vi.fn();
        const emitDragEnd = vi.fn();
        const dragging = useDragging({
            startDragging: startDraggingMock,
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
                button: 0,
                clientX: 10,
                clientY: 10,
                preventDefault: vi.fn(),
                target: container,
                currentTarget: container,
            })
        );
        expect(startDraggingMock).not.toHaveBeenCalled();
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20, buttons: 1 }));
        await flushAsyncWork();
        await vi.advanceTimersByTimeAsync(100);

        expect(emitDragStart).toHaveBeenCalledTimes(1);
        expect(startDraggingMock).toHaveBeenCalledTimes(1);
        expect(emitDragEnd).toHaveBeenCalledTimes(1);
    });

    it('user moves beyond the click threshold and starts the window drag with the current pointer position', async () => {
        const startDragging = vi.fn().mockResolvedValue(undefined);
        const emitDragEnd = vi.fn();
        const dragging = useDragging({
            editor: shallowRef(null),
            emitDragStart: vi.fn(),
            emitDragEnd,
            startDragging,
        });
        const container = document.createElement('div');
        const event = asMouseEvent({
            button: 0,
            clientX: 320,
            clientY: 180,
            preventDefault: vi.fn(),
            target: container,
            currentTarget: container,
        });

        await dragging.handleContainerMouseDown(event);
        expect(startDragging).not.toHaveBeenCalled();
        const movement = new MouseEvent('mousemove', {
            clientX: 330,
            clientY: 190,
            buttons: 1,
        });
        window.dispatchEvent(movement);
        await flushAsyncWork();

        expect(startDragging).toHaveBeenCalledWith(movement);
        expect(startDraggingMock).not.toHaveBeenCalled();
        expect(emitDragEnd).toHaveBeenCalledTimes(1);
    });

    it('user drags an empty editor beyond the threshold and avoids an accidental click on release', async () => {
        const emitDragStart = vi.fn();
        const emitDragEnd = vi.fn();
        const target = document.createElement('div');
        resolveMouseEventTargetMock.mockReturnValue(target);
        const dragging = useDragging({
            startDragging: startDraggingMock,
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
                buttons: 1,
            })
        );
        await flushAsyncWork();

        expect(startDraggingMock).toHaveBeenCalledTimes(1);
        expect(dragging.consumeEditorClickAfterDrag()).toBe(true);
        expect(dragging.consumeEditorClickAfterDrag()).toBe(false);
    });

    it('user gets no window drag when clicking near selectable text', async () => {
        const target = document.createElement('div');
        resolveMouseEventTargetMock.mockReturnValue(target);
        isBlankEditorAreaTargetMock.mockReturnValue(true);
        const dragging = useDragging({
            startDragging: startDraggingMock,
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

    it('user clicks blank space after text with minor pointer jitter without dragging or suppressing the click', async () => {
        const target = document.createElement('div');
        resolveMouseEventTargetMock.mockReturnValue(target);
        isBlankEditorAreaTargetMock.mockReturnValue(true);
        const dragging = useDragging({
            startDragging: startDraggingMock,
            editor: shallowRef(
                createEditor({
                    isEmpty: false,
                    posAtCoords: { pos: 8 },
                    coordsAtPos: {
                        left: 100,
                        right: 160,
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
                clientX: 260,
                clientY: 110,
            })
        );
        window.dispatchEvent(
            new MouseEvent('mousemove', { clientX: 262, clientY: 111, buttons: 1 })
        );
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 262, clientY: 111 }));
        await flushAsyncWork();

        expect(startDraggingMock).not.toHaveBeenCalled();
        expect(dragging.consumeEditorClickAfterDrag()).toBe(false);
    });

    it.each([
        [110, false],
        [260, true],
    ])(
        'user drags at x=%s and preserves text selection when starting near text',
        async (clientX, shouldDrag) => {
            const paragraph = document.createElement('p');
            resolveMouseEventTargetMock.mockReturnValue(paragraph);
            isBlankEditorAreaTargetMock.mockReturnValue(true);
            const dragging = useDragging({
                startDragging: startDraggingMock,
                editor: shallowRef(
                    createEditor({
                        isEmpty: false,
                        posAtCoords: { pos: 8 },
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

            await dragging.handleEditorMouseDown(
                asMouseEvent({
                    button: 0,
                    clientX,
                    clientY: 110,
                    target: paragraph,
                    preventDefault: vi.fn(),
                    stopPropagation: vi.fn(),
                })
            );
            expect(startDraggingMock).not.toHaveBeenCalled();
            window.dispatchEvent(
                new MouseEvent('mousemove', { clientX: clientX + 20, clientY: 110, buttons: 1 })
            );
            await flushAsyncWork();

            expect(startDraggingMock).toHaveBeenCalledTimes(shouldDrag ? 1 : 0);
        }
    );

    it('user presses blank space after text and starts native dragging only after deliberate movement', async () => {
        const target = document.createElement('div');
        resolveMouseEventTargetMock.mockReturnValue(target);
        isBlankEditorAreaTargetMock.mockReturnValue(true);
        const startDragging = vi.fn().mockResolvedValue(undefined);
        const dragging = useDragging({
            editor: shallowRef(
                createEditor({
                    isEmpty: false,
                    posAtCoords: { pos: 8 },
                    coordsAtPos: {
                        left: 100,
                        right: 160,
                        top: 100,
                        bottom: 120,
                    },
                }) as never
            ),
            emitDragStart: vi.fn(),
            emitDragEnd: vi.fn(),
            startDragging,
        });
        const event = new MouseEvent('mousedown', {
            button: 0,
            clientX: 260,
            clientY: 110,
            cancelable: true,
        });

        const handled = dragging.handleEditorMouseDown(event);
        await flushAsyncWork();

        expect(handled).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(startDragging).not.toHaveBeenCalled();
        const movement = new MouseEvent('mousemove', {
            clientX: 280,
            clientY: 110,
            buttons: 1,
        });
        window.dispatchEvent(movement);
        await flushAsyncWork();
        expect(startDragging).toHaveBeenCalledWith(movement);
    });

    it('user resets the input after dragging and can click normally again', async () => {
        const target = document.createElement('div');
        resolveMouseEventTargetMock.mockReturnValue(target);
        const dragging = useDragging({
            startDragging: startDraggingMock,
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
                buttons: 1,
            })
        );
        await flushAsyncWork();

        dragging.clearEditorSelectionDragState();

        expect(dragging.consumeEditorClickAfterDrag()).toBe(false);
    });

    it.each(['mouseup', 'blur', 'dispose'])(
        'user ends a pending gesture with %s and later pointer movement cannot start a drag',
        async (ending) => {
            resolveMouseEventTargetMock.mockReturnValue(document.createElement('div'));
            const dragging = useDragging({
                startDragging: startDraggingMock,
                editor: shallowRef(createEditor({ isEmpty: true }) as never),
                emitDragStart: vi.fn(),
                emitDragEnd: vi.fn(),
            });
            dragging.handleEditorMouseDown(
                new MouseEvent('mousedown', { button: 0, clientX: 5, clientY: 5 })
            );
            if (ending === 'dispose') dragging.clearEditorSelectionDragState();
            else window.dispatchEvent(new Event(ending));
            window.dispatchEvent(
                new MouseEvent('mousemove', { clientX: 30, clientY: 30, buttons: 1 })
            );
            await flushAsyncWork();
            expect(startDraggingMock).not.toHaveBeenCalled();
        }
    );
});
