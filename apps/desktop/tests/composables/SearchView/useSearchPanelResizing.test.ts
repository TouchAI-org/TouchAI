import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, shallowRef } from 'vue';

import { useSearchPanelResizing } from '@/views/SearchView/composables/useSearchPanelResizing';

const { outerPosition, scaleFactor, currentMonitor } = vi.hoisted(() => ({
    outerPosition: vi.fn(),
    scaleFactor: vi.fn(),
    currentMonitor: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ outerPosition, scaleFactor }),
    currentMonitor,
}));

function pointer(type: string, screenX: number, screenY: number, clientX = screenX, pointerId = 7) {
    const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY: screenY,
        screenX,
        screenY,
    });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    return event as unknown as PointerEvent;
}

function createHarness(panelRect = new DOMRect(48, 64, 750, 290)) {
    const panel = document.createElement('div');
    panel.getBoundingClientRect = () => panelRect;
    const previewResize = vi.fn(async (): Promise<unknown> => undefined);
    const commitResize = vi.fn(async (): Promise<unknown> => undefined);
    const cancelResize = vi.fn(async (): Promise<unknown> => undefined);
    const beginResize = vi.fn(() => ({ width: 750, height: 290 }));
    const onResizeStart = vi.fn();
    const onResizeEnd = vi.fn();
    const enabled = ref(true);
    const panelBounds = ref({ top: 64, bottom: 792 });
    const options = {
        panel: shallowRef(panel),
        panelBounds,
        enabled,
        allowHeightOverride: ref(true),
        minimumSize: ref({ width: 750, height: 60 }),
        beginResize,
        previewResize,
        commitResize,
        cancelResize,
        onResizeStart,
        onResizeEnd,
    };
    const resizing = useSearchPanelResizing(options);
    return {
        resizing,
        enabled,
        beginResize,
        panelBounds,
        previewResize,
        commitResize,
        cancelResize,
        onResizeEnd,
    };
}

describe('given a bounded search window', () => {
    beforeEach(() => {
        outerPosition.mockResolvedValue({ x: 200, y: 180 });
        scaleFactor.mockResolvedValue(1.5);
        currentMonitor.mockResolvedValue({
            workArea: { position: { x: 0, y: 40 }, size: { width: 2560, height: 1400 } },
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([
        { hostY: 200, direction: 'n' as const, delta: -400, expectedTop: 296, expectedBottom: 885 },
        { hostY: -200, direction: 's' as const, delta: 600, expectedTop: 195, expectedBottom: 832 },
    ])(
        'keeps the opposite edge fixed when resizing a host at $hostY',
        async ({ hostY, direction, delta, expectedTop, expectedBottom }) => {
            outerPosition.mockResolvedValue({ x: 200, y: hostY });
            scaleFactor.mockResolvedValue(1);
            vi.stubGlobal('innerHeight', 1080);
            currentMonitor.mockResolvedValue({
                workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
            });
            const harness = createHarness(new DOMRect(48, 395, 750, 290));
            harness.panelBounds.value = {
                top: hostY > 0 ? 96 : 296,
                bottom: hostY > 0 ? 832 : 1032,
            };
            const finished = harness.resizing.startResizing(
                direction,
                pointer('pointerdown', 500, 500)
            );
            await flushPromises();
            window.dispatchEvent(pointer('pointerup', 500, 500 + delta));
            await finished;
            const calls = harness.previewResize.mock.calls;
            const [size, origin] = calls[calls.length - 1]! as unknown as [
                { height: number },
                { y: number },
            ];
            expect(origin.y + 96).toBe(expectedTop);
            expect(origin.y + 96 + size.height).toBe(expectedBottom);
        }
    );

    it.each([100, 180])(
        'user can resize horizontally with only %s pixels visible',
        async (visibleHeight) => {
            outerPosition.mockResolvedValue({ x: 200, y: 1080 - visibleHeight });
            scaleFactor.mockResolvedValue(1);
            currentMonitor.mockResolvedValue({
                workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
            });
            const top = ((visibleHeight - 60) * 2) / 3;
            const harness = createHarness(new DOMRect(48, top, 750, 60));
            harness.panelBounds.value = { top, bottom: top + 60 };
            harness.beginResize.mockReturnValue({ width: 750, height: 60 });
            const finished = harness.resizing.startResizing(
                'ne',
                pointer('pointerdown', 800, 1000)
            );
            await flushPromises();
            window.dispatchEvent(pointer('pointerup', 900, 1000));
            await finished;
            expect(harness.previewResize).toHaveBeenLastCalledWith(
                { width: 850, height: 60 },
                expect.anything()
            );
        }
    );

    it('user reaches the latest pointer position when several moves arrive during a native resize', async () => {
        const harness = createHarness();
        let finishFirst!: () => void;
        harness.previewResize.mockImplementationOnce(
            () => new Promise<void>((resolve) => (finishFirst = resolve))
        );
        const finished = harness.resizing.startResizing('se', pointer('pointerdown', 800, 500));
        await flushPromises();

        window.dispatchEvent(pointer('pointermove', 850, 550));
        await flushPromises();
        window.dispatchEvent(pointer('pointermove', 900, 600));
        window.dispatchEvent(pointer('pointermove', 950, 650));
        const updatesBeforeAcknowledgement = harness.previewResize.mock.calls.length;
        window.dispatchEvent(pointer('pointerup', 950, 650));
        const commitsBeforeAcknowledgement = harness.commitResize.mock.calls.length;
        finishFirst();
        await finished;

        expect(updatesBeforeAcknowledgement).toBe(1);
        expect(commitsBeforeAcknowledgement).toBe(0);
        expect(harness.previewResize).toHaveBeenCalledTimes(2);
        expect(harness.previewResize).toHaveBeenLastCalledWith(
            { width: 900, height: 440 },
            { x: 200, y: 180 }
        );
        expect(harness.commitResize).toHaveBeenCalledTimes(1);
        expect(harness.onResizeEnd).toHaveBeenCalledTimes(1);
    });

    it('user keeps the west edge under the pointer when moving the window changes client coordinates', async () => {
        const harness = createHarness();
        const finished = harness.resizing.startResizing('w', pointer('pointerdown', 300, 350, 48));
        await flushPromises();
        window.dispatchEvent(pointer('pointermove', 200, 350, -52));
        await flushPromises();
        window.dispatchEvent(pointer('pointermove', 200, 350, 48));
        window.dispatchEvent(pointer('pointerup', 200, 350, 48));
        await finished;

        expect(harness.previewResize).toHaveBeenLastCalledWith(
            { width: 850, height: 290 },
            { x: 50, y: 180 }
        );
    });

    it.each(['pointercancel', 'blur', 'Escape'])(
        'user restores the original frame after %s interrupts a pending move',
        async (reason) => {
            const harness = createHarness();
            let finishFirst!: () => void;
            harness.previewResize.mockImplementationOnce(
                () => new Promise<void>((resolve) => (finishFirst = resolve))
            );
            const finished = harness.resizing.startResizing('se', pointer('pointerdown', 800, 500));
            await flushPromises();
            window.dispatchEvent(pointer('pointermove', 850, 550));
            await flushPromises();
            window.dispatchEvent(pointer('pointermove', 950, 650));
            window.dispatchEvent(
                reason === 'Escape'
                    ? new KeyboardEvent('keydown', { key: 'Escape' })
                    : reason === 'blur'
                      ? new Event('blur')
                      : pointer('pointercancel', 950, 650)
            );
            finishFirst();
            await finished;

            expect(harness.previewResize).toHaveBeenCalledTimes(1);
            expect(harness.cancelResize).toHaveBeenCalledWith({ x: 200, y: 180 });
            expect(harness.commitResize).not.toHaveBeenCalled();
            expect(harness.onResizeEnd).toHaveBeenCalledTimes(1);
        }
    );

    it('user releases the pointer before the window origin loads without starting a ghost resize', async () => {
        let resolvePosition!: (value: { x: number; y: number }) => void;
        outerPosition.mockImplementationOnce(
            () => new Promise((resolve) => (resolvePosition = resolve))
        );
        const harness = createHarness();
        const finished = harness.resizing.startResizing('e', pointer('pointerdown', 800, 350));
        window.dispatchEvent(pointer('pointerup', 800, 350));
        resolvePosition({ x: 200, y: 180 });
        await finished;

        expect(harness.previewResize).not.toHaveBeenCalled();
        expect(harness.resizing.cancelResizing()).toBe(false);
        expect(harness.onResizeEnd).toHaveBeenCalledTimes(1);
    });

    it('user can start again after a failed native resize restores the original frame', async () => {
        const harness = createHarness();
        harness.previewResize.mockRejectedValueOnce(new Error('Host failed'));
        const finished = harness.resizing.startResizing('e', pointer('pointerdown', 800, 350));
        const rejected = expect(finished).rejects.toThrow('Host failed');
        await flushPromises();
        window.dispatchEvent(pointer('pointermove', 900, 350));
        await rejected;

        expect(harness.cancelResize).toHaveBeenCalledWith({ x: 200, y: 180 });
        expect(harness.resizing.cancelResizing()).toBe(false);
        const second = harness.resizing.startResizing('e', pointer('pointerdown', 800, 350));
        await flushPromises();
        window.dispatchEvent(pointer('pointermove', 900, 350));
        window.dispatchEvent(pointer('pointerup', 900, 350));
        await second;
        expect(harness.commitResize).toHaveBeenCalledTimes(1);
        expect(harness.onResizeEnd).toHaveBeenCalledTimes(2);
    });

    it('user cannot start a second gesture while the previous commit is settling', async () => {
        const harness = createHarness();
        let resolveCommit!: () => void;
        harness.commitResize.mockImplementationOnce(
            () => new Promise<void>((resolve) => (resolveCommit = resolve))
        );
        const first = harness.resizing.startResizing('e', pointer('pointerdown', 800, 350));
        await flushPromises();
        window.dispatchEvent(pointer('pointerup', 800, 350));
        await flushPromises();
        await harness.resizing.startResizing('w', pointer('pointerdown', 200, 350, 200, 8));
        resolveCommit();
        await first;
        expect(harness.beginResize).toHaveBeenCalledTimes(1);
        expect(harness.resizing.cancelResizing()).toBe(false);
    });
});
