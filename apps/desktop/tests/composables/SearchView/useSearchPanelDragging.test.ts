import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useSearchPanelDragging } from '@/views/SearchView/composables/useSearchPanelDragging';

const { startDraggingMock } = vi.hoisted(() => ({ startDraggingMock: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ startDragging: startDraggingMock }),
}));

const mouse = () => new MouseEvent('mousedown', { button: 0 });

describe('given a movable search window', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        startDraggingMock.mockResolvedValue(undefined);
    });

    it('user starts native dragging after the interrupted animation has settled', async () => {
        let finishPreparation!: (value: boolean) => void;
        const preparation = new Promise<boolean>((resolve) => {
            finishPreparation = resolve;
        });
        const dragging = useSearchPanelDragging({
            maximized: ref(false),
            prepareForNativeDrag: () => preparation,
        });
        const started = dragging.startDragging(mouse());
        expect(startDraggingMock).not.toHaveBeenCalled();
        finishPreparation(true);
        await started;
        expect(startDraggingMock).toHaveBeenCalledTimes(1);
    });

    it.each(['mouseup', 'blur'])(
        'user avoids a delayed native drag when %s interrupts preparation',
        async (reason) => {
            let finishPreparation!: (value: boolean) => void;
            const preparation = new Promise<boolean>((resolve) => {
                finishPreparation = resolve;
            });
            const dragging = useSearchPanelDragging({
                maximized: ref(false),
                prepareForNativeDrag: () => preparation,
            });
            const started = dragging.startDragging(mouse());
            window.dispatchEvent(new Event(reason));
            finishPreparation(true);
            await started;
            expect(startDraggingMock).not.toHaveBeenCalled();
            expect(dragging.cancelDragging()).toBe(false);
        }
    );

    it('user keeps the maximized window in place when attempting to drag', async () => {
        const dragging = useSearchPanelDragging({ maximized: ref(true) });
        await dragging.startDragging(mouse());
        expect(startDraggingMock).not.toHaveBeenCalled();
    });

    it('user can drag again after the native operation fails', async () => {
        const dragging = useSearchPanelDragging({ maximized: ref(false) });
        startDraggingMock.mockRejectedValueOnce(new Error('Drag failed'));
        await expect(dragging.startDragging(mouse())).rejects.toThrow('Drag failed');
        await dragging.startDragging(mouse());
        expect(startDraggingMock).toHaveBeenCalledTimes(2);
        expect(dragging.cancelDragging()).toBe(false);
    });

    it('user cannot start a pending drag after the view is disposed', async () => {
        let finishPreparation!: (value: boolean) => void;
        const preparation = new Promise<boolean>((resolve) => {
            finishPreparation = resolve;
        });
        const dragging = useSearchPanelDragging({
            maximized: ref(false),
            prepareForNativeDrag: () => preparation,
        });
        const started = dragging.startDragging(mouse());
        dragging.dispose();
        finishPreparation(true);
        await started;
        expect(startDraggingMock).not.toHaveBeenCalled();
    });
});
