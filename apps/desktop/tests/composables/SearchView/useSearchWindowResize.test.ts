import { mountComposable } from '@tests/utils/composables';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { SEARCH_SURFACE_MOTION, SearchWindowHeightMode } from '@/config/searchWindow';
import { useSearchWindowResize } from '@/views/SearchView/composables/useSearchWindowResize';
import { resolveAutoSessionPanelHeight } from '@/views/SearchView/windowSizing';

const {
    currentWindowMock,
    currentMonitorMock,
    nativeMock,
    windowResizeMock,
    windowScaleMock,
    windowMoveMock,
} = vi.hoisted(() => {
    let moveListener: ((event: { payload: { x: number; y: number } }) => void) | null = null;
    let resizeListener: ((event: { payload: { width: number; height: number } }) => void) | null =
        null;
    let scaleChangedListener:
        | ((event: {
              payload: { scaleFactor: number; size: { width: number; height: number } };
          }) => void)
        | null = null;

    return {
        currentMonitorMock: vi.fn(),
        currentWindowMock: {
            isVisible: vi.fn(),
            isMaximized: vi.fn(),
            maximize: vi.fn(),
            unmaximize: vi.fn(),
            onResized: vi.fn(
                async (
                    listener: (event: { payload: { width: number; height: number } }) => void
                ) => {
                    resizeListener = listener;
                    return () => undefined;
                }
            ),
            onMoved: vi.fn(
                async (listener: (event: { payload: { x: number; y: number } }) => void) => {
                    moveListener = listener;
                    return () => {
                        moveListener = null;
                    };
                }
            ),
            outerPosition: vi.fn(async () => ({ x: 0, y: 100 })),
            outerSize: vi.fn(),
            setPosition: vi
                .fn<(position: { x: number; y: number }) => Promise<void>>()
                .mockResolvedValue(undefined),
            onScaleChanged: vi.fn(
                async (
                    listener: (event: {
                        payload: {
                            scaleFactor: number;
                            size: { width: number; height: number };
                        };
                    }) => void
                ) => {
                    scaleChangedListener = listener;
                    return () => undefined;
                }
            ),
        },
        nativeMock: {
            window: {
                getSearchWindowState: vi.fn(),
                commitSearchPanelResize: vi.fn(),
                resizeWindowHeight: vi.fn(),
                resetSearchWindowBounds: vi.fn(),
                setSearchWindowAllowHeightOverride: vi.fn(),
                setSearchWindowDefaults: vi.fn(),
                setSearchWindowMinSize: vi.fn(),
            },
        },
        windowScaleMock: {
            emit(scaleFactor: number, size = { width: 2560, height: 1440 }) {
                scaleChangedListener?.({ payload: { scaleFactor, size } });
            },
            reset() {
                scaleChangedListener = null;
            },
        },
        windowResizeMock: {
            emit(width: number, height: number) {
                resizeListener?.({ payload: { width, height } });
            },
            reset() {
                resizeListener = null;
            },
        },
        windowMoveMock: {
            emit(x: number, y: number) {
                moveListener?.({ payload: { x, y } });
            },
        },
    };
});

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => currentWindowMock,
    currentMonitor: currentMonitorMock,
}));

vi.mock('@services/NativeService', () => ({
    native: nativeMock,
}));

class ResizeObserverMock {
    static instances: ResizeObserverMock[] = [];

    readonly observed: Element[] = [];
    disconnected = false;

    constructor(private readonly callback: ResizeObserverCallback) {
        ResizeObserverMock.instances.push(this);
    }

    observe(target: Element) {
        this.observed.push(target);
    }

    disconnect() {
        this.disconnected = true;
    }

    emit(target: HTMLElement) {
        this.callback(
            [
                {
                    target,
                    borderBoxSize: [],
                    contentBoxSize: [],
                    contentRect: target.getBoundingClientRect(),
                    devicePixelContentBoxSize: [],
                } as unknown as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver
        );
    }
}

function createWindowState(
    overrides: Partial<{
        currentWidth: number;
        currentHeight: number;
        heightMode: SearchWindowHeightMode;
        monitorHost: boolean;
    }> = {}
) {
    return {
        defaults: { width: 750, height: 60 },
        currentWidth: 750,
        currentHeight: 60,
        heightMode: SearchWindowHeightMode.Auto,
        monitorHost: true,
        ...overrides,
    };
}

function createMeasuredElement(height: number) {
    const element = document.createElement('div');
    let measuredHeight = height;

    for (const property of ['clientHeight', 'scrollHeight', 'offsetHeight'] as const) {
        Object.defineProperty(element, property, {
            configurable: true,
            get: () => measuredHeight,
        });
    }

    element.getBoundingClientRect = () =>
        ({
            width: 600,
            height: measuredHeight,
            top: 0,
            left: 0,
            right: 600,
            bottom: measuredHeight,
            x: 0,
            y: 0,
            toJSON: () => undefined,
        }) as DOMRect;

    return {
        element,
        setHeight(value: number) {
            measuredHeight = value;
        },
    };
}

function createAnimatedCard(height: number) {
    const measured = createMeasuredElement(height);
    const animations: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];
    measured.element.animate = vi.fn(() => {
        let finish: () => void = () => undefined;
        let rejectAnimation: (error: Error) => void = () => undefined;
        const finished = new Promise<Animation>((resolve, reject) => {
            finish = () => resolve(animation);
            rejectAnimation = reject;
        });
        const cancel = vi.fn(() => rejectAnimation(new DOMException('Cancelled', 'AbortError')));
        const animation = { finished, cancel, finish } as unknown as Animation;
        animations.push({ finish, cancel });
        return animation;
    });
    return { ...measured, animations };
}

function lastCommit() {
    const calls = nativeMock.window.commitSearchPanelResize.mock.calls;
    return calls[calls.length - 1]?.[0];
}

async function flushLifecycle() {
    await flushPromises();
    await nextTick();
}

async function advanceMeasurementTimers() {
    await vi.advanceTimersByTimeAsync(60);
    await flushLifecycle();
}

describe('useSearchWindowResize', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        ResizeObserverMock.instances = [];
        windowResizeMock.reset();
        windowScaleMock.reset();

        vi.stubGlobal('ResizeObserver', ResizeObserverMock);

        currentWindowMock.isVisible.mockResolvedValue(true);
        currentWindowMock.isMaximized.mockResolvedValue(false);
        currentWindowMock.maximize.mockResolvedValue(undefined);
        currentWindowMock.unmaximize.mockResolvedValue(undefined);
        vi.stubGlobal('innerHeight', 1080);
        currentWindowMock.outerPosition.mockResolvedValue({ x: 0, y: 0 });
        currentWindowMock.outerSize.mockResolvedValue({ width: 846, height: 1080 });
        currentMonitorMock.mockResolvedValue({
            workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
        });
        currentWindowMock.setPosition.mockResolvedValue(undefined);

        nativeMock.window.getSearchWindowState.mockResolvedValue(createWindowState());
        nativeMock.window.commitSearchPanelResize.mockImplementation(
            async ({ to }: { to: { width: number; height: number } }) => ({
                ...createWindowState({ currentWidth: to.width, currentHeight: to.height }),
                monitorHost: true,
            })
        );
        nativeMock.window.resizeWindowHeight.mockResolvedValue(undefined);
        nativeMock.window.resetSearchWindowBounds.mockResolvedValue(undefined);
        nativeMock.window.setSearchWindowAllowHeightOverride.mockResolvedValue(undefined);
        nativeMock.window.setSearchWindowDefaults.mockImplementation(async (defaults) => defaults);
        nativeMock.window.setSearchWindowMinSize.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    async function mount(overrides: Record<string, unknown> = {}) {
        const target = ref<HTMLElement | null>(null);
        const sessionCount = ref(0);
        const quickSearchOpen = ref(false);
        const ready = ref(true);

        const mounted = await mountComposable(() =>
            useSearchWindowResize({
                target,
                sessionCount,
                quickSearchOpen,
                defaultSize: ref({ width: 750, height: 60 }),
                ready,
                ...overrides,
            })
        );

        return { mounted, target, sessionCount, quickSearchOpen, ready };
    }

    it('applies the idle defaults and pins the min-height to the configured idle height', async () => {
        const { mounted } = await mount();

        await flushLifecycle();

        expect(nativeMock.window.setSearchWindowDefaults).toHaveBeenCalledWith({
            width: 750,
            height: 60,
        });
        expect(nativeMock.window.resetSearchWindowBounds).toHaveBeenCalled();
        expect(nativeMock.window.setSearchWindowAllowHeightOverride).toHaveBeenCalledWith(false);

        mounted.unmount();
    });

    it('user sees intrinsic content fit even when the previous card left space above it', async () => {
        const measured = createMeasuredElement(240);
        measured.element.getBoundingClientRect = () =>
            ({ top: 300, bottom: 540, height: 240 }) as DOMRect;
        const card = createMeasuredElement(540);
        const { mounted, target } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        target.value = measured.element;
        await flushLifecycle();
        await mounted.result.remeasureTargetHeight();

        expect(mounted.result.currentHeight.value).toBe(240);
        mounted.unmount();
    });

    it('user can hold first-open measurements until the conversation replaces the old results', async () => {
        const measured = createMeasuredElement(60);
        const { mounted, target } = await mount();
        await flushLifecycle();
        target.value = measured.element;
        await flushLifecycle();
        mounted.result.measurementHold.value = true;
        measured.setHeight(620);
        await mounted.result.remeasureTargetHeight();
        expect(mounted.result.currentHeight.value).toBe(60);

        measured.setHeight(260);
        mounted.result.measurementHold.value = false;
        await advanceMeasurementTimers();
        expect(mounted.result.currentHeight.value).toBe(260);
        mounted.unmount();
    });

    it('user keeps manual geometry during direct overlay remeasurement', async () => {
        const measured = createMeasuredElement(311);
        const card = createAnimatedCard(60);
        const overlayRequiredViewportHeight = ref<number | null>(null);
        const { mounted, target } = await mount({
            card: ref(card.element),
            sessionCount: ref(2),
            overlayRequiredViewportHeight,
        });
        await flushLifecycle();
        card.setHeight(850);
        nativeMock.window.getSearchWindowState.mockResolvedValue(
            createWindowState({
                currentHeight: 850,
                heightMode: SearchWindowHeightMode.ManualOverride,
            })
        );
        await mounted.result.syncWindowState();
        target.value = measured.element;
        await flushLifecycle();
        nativeMock.window.commitSearchPanelResize.mockClear();
        nativeMock.window.commitSearchPanelResize.mockImplementation(async () => ({
            ...createWindowState({
                currentHeight: 850,
                heightMode: SearchWindowHeightMode.ManualOverride,
            }),
        }));

        overlayRequiredViewportHeight.value = 1100;
        const remeasure = mounted.result.remeasureTargetHeight();
        await flushLifecycle();
        const animated = card.animations.length;
        card.animations.forEach((animation) => animation.finish());
        await remeasure;

        expect(animated).toBe(0);
        expect(mounted.result.cardHeight.value).toBe(850);
        expect(nativeMock.window.commitSearchPanelResize).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it.each([false, true])(
        'user gets no automatic resize retry loop after a native failure with an overlay %s',
        async (withOverlay) => {
            const measured = createMeasuredElement(240);
            const overlayTarget = ref<HTMLElement | null>(null);
            const { mounted, target } = await mount({ overlayTarget });
            await flushLifecycle();
            mounted.result.measurementHold.value = true;
            if (withOverlay) {
                overlayTarget.value = createMeasuredElement(1100).element;
            }
            target.value = measured.element;
            await flushLifecycle();
            nativeMock.window.commitSearchPanelResize.mockRejectedValue(
                new Error('native unavailable')
            );
            mounted.result.measurementHold.value = false;
            await vi.advanceTimersByTimeAsync(350);
            expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledTimes(1);
            for (let i = 0; i < 3; i++) {
                ResizeObserverMock.instances[ResizeObserverMock.instances.length - 1]?.emit(
                    measured.element
                );
                await advanceMeasurementTimers();
            }
            await vi.advanceTimersByTimeAsync(350);
            expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledTimes(1);

            nativeMock.window.commitSearchPanelResize.mockResolvedValue(
                createWindowState({ currentHeight: 260 })
            );
            measured.setHeight(260);
            overlayTarget.value = null;
            ResizeObserverMock.instances[ResizeObserverMock.instances.length - 1]?.emit(
                measured.element
            );
            await advanceMeasurementTimers();
            expect(mounted.result.currentHeight.value).toBe(260);
            mounted.unmount();
        }
    );

    it('user opening a new session on a non-monitor host clears manual sizing and uses accepted bounds', async () => {
        const { mounted } = await mount();
        await flushLifecycle();
        nativeMock.window.getSearchWindowState.mockResolvedValue(
            createWindowState({
                currentHeight: 850,
                heightMode: SearchWindowHeightMode.ManualOverride,
                monitorHost: false,
            })
        );
        await mounted.result.syncWindowState();
        nativeMock.window.getSearchWindowState.mockResolvedValue(
            createWindowState({
                currentHeight: 280,
                monitorHost: false,
            })
        );
        await mounted.result.playSessionExpandAnimation(311);

        expect(nativeMock.window.resizeWindowHeight).toHaveBeenCalledWith(
            expect.objectContaining({
                targetHeight: 311,
                respectManualOverride: false,
            })
        );
        expect(mounted.result.currentHeight.value).toBe(280);
        mounted.unmount();
    });

    it('user keeps the input within the monitor work area at 150 percent scale', async () => {
        currentMonitorMock.mockResolvedValue({
            workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
        });
        const { mounted, target } = await mount();
        await flushLifecycle();
        windowScaleMock.emit(1.5);
        await mounted.result.syncWindowState();
        mounted.result.measurementHold.value = true;
        target.value = createMeasuredElement(1000).element;
        await flushLifecycle();

        expect(mounted.result.measureTargetHeight()).toBe(581);
        await mounted.result.playSessionExpandAnimation(660);
        expect(lastCommit()?.to.height).toBe(581);
        mounted.unmount();
    });

    it('user gets window constraints only after the view becomes ready', async () => {
        const ready = ref(false);
        const { mounted } = await mount({ ready });
        await flushLifecycle();

        expect(nativeMock.window.setSearchWindowDefaults).not.toHaveBeenCalled();
        expect(mounted.result.contentReady.value).toBe(false);

        ready.value = true;
        await flushLifecycle();

        expect(nativeMock.window.setSearchWindowDefaults).toHaveBeenCalledWith({
            width: 750,
            height: 60,
        });
        expect(mounted.result.contentReady.value).toBe(true);
        mounted.unmount();
    });

    it('user gets updated width constraints without reapplying an unchanged preset', async () => {
        const defaultSize = ref({ width: 750, height: 60 });
        const { mounted } = await mount({ defaultSize });
        await flushLifecycle();
        nativeMock.window.setSearchWindowDefaults.mockClear();

        defaultSize.value = { width: 750, height: 60 };
        await flushLifecycle();
        expect(nativeMock.window.setSearchWindowDefaults).not.toHaveBeenCalled();

        defaultSize.value = { width: 900, height: 60 };
        await flushLifecycle();
        expect(nativeMock.window.setSearchWindowDefaults).toHaveBeenCalledWith(defaultSize.value);
        mounted.unmount();
    });

    it('user can replace and remove the content without leaving stale observers', async () => {
        const first = createMeasuredElement(180);
        const second = createMeasuredElement(240);
        const { mounted, target } = await mount();

        target.value = first.element;
        await flushLifecycle();
        const firstObserver =
            ResizeObserverMock.instances[ResizeObserverMock.instances.length - 1]!;

        target.value = second.element;
        await flushLifecycle();
        const secondObserver =
            ResizeObserverMock.instances[ResizeObserverMock.instances.length - 1]!;
        expect(firstObserver.disconnected).toBe(true);
        expect(secondObserver.observed).toEqual([second.element]);

        target.value = null;
        await flushLifecycle();
        expect(secondObserver.disconnected).toBe(true);
        mounted.unmount();
    });

    it('commits the measured content height when the content grows', async () => {
        const measured = createMeasuredElement(60);
        const { mounted, target } = await mount();

        target.value = measured.element;
        await flushLifecycle();

        measured.setHeight(240);
        ResizeObserverMock.instances[0]?.emit(measured.element);
        await advanceMeasurementTimers();

        expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledWith(
            expect.objectContaining({ to: { width: 750, height: 240 }, auto: true })
        );

        mounted.unmount();
    });

    it('does not re-send the same measured height', async () => {
        const measured = createMeasuredElement(240);
        const { mounted, target } = await mount();

        target.value = measured.element;
        await flushLifecycle();
        await advanceMeasurementTimers();
        nativeMock.window.commitSearchPanelResize.mockClear();

        ResizeObserverMock.instances[0]?.emit(measured.element);
        await advanceMeasurementTimers();

        expect(nativeMock.window.commitSearchPanelResize).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('clamps a long conversation to the auto conversation cap', async () => {
        const measured = createMeasuredElement(10);
        const { mounted, target, sessionCount } = await mount();
        sessionCount.value = 1;

        target.value = measured.element;
        await flushLifecycle();

        measured.setHeight(5000);
        ResizeObserverMock.instances[0]?.emit(measured.element);
        await advanceMeasurementTimers();

        const commit = lastCommit();
        expect(commit?.to.height).toBe(resolveAutoSessionPanelHeight({ searchBarHeight: 60 }));

        mounted.unmount();
    });

    it('user gets the full native host height as soon as content grows', async () => {
        const measured = createMeasuredElement(60);
        const { mounted, target } = await mount();

        target.value = measured.element;
        await flushLifecycle();

        measured.setHeight(300);
        ResizeObserverMock.instances[0]?.emit(measured.element);
        await advanceMeasurementTimers();

        // The content is already laid out at the new height, so the host has to apply it
        // immediately instead of animating and clipping the content it is catching up to.
        expect(lastCommit()?.to).toEqual({ width: 750, height: 300 });
        expect(mounted.result.currentHeight.value).toBe(300);

        mounted.unmount();
    });

    it('opens a session with one commit of the measured target', async () => {
        const measured = createMeasuredElement(60);
        const { mounted, target } = await mount();

        target.value = measured.element;
        await flushLifecycle();
        nativeMock.window.commitSearchPanelResize.mockClear();

        measured.setHeight(290);
        await mounted.result.playSessionExpandAnimation(290);

        expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledWith(
            expect.objectContaining({ to: { width: 750, height: 290 } })
        );

        mounted.unmount();
    });

    it('collapses a session back to the compact height', async () => {
        const measured = createMeasuredElement(290);
        const { mounted, target, sessionCount } = await mount();
        sessionCount.value = 1;

        target.value = measured.element;
        await flushLifecycle();
        await mounted.result.remeasureTargetHeight();
        nativeMock.window.commitSearchPanelResize.mockClear();

        measured.setHeight(60);
        const collapse = mounted.result.collapseSessionToIdle();
        await vi.advanceTimersByTimeAsync(SEARCH_SURFACE_MOTION.durationMs + 20);
        await collapse;

        expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledWith(
            expect.objectContaining({ to: { width: 750, height: 60 } })
        );
        expect(mounted.result.isCardGrowing.value).toBe(false);

        mounted.unmount();
    });

    it('user keeps conversation content until the collapse finishes', async () => {
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        await mounted.result.playSessionExpandAnimation(290);
        card.animations[0]!.finish();
        await flushLifecycle();
        card.setHeight(290);
        let mayClearContent = false;
        const collapse = mounted.result.collapseSessionToIdle().then(() => {
            mayClearContent = true;
        });
        await flushLifecycle();
        expect(mayClearContent).toBe(false);
        card.animations[1]!.finish();
        await collapse;
        expect(mayClearContent).toBe(true);
        expect(mounted.result.cardHeight.value).toBe(60);
        mounted.unmount();
    });

    it('resets to the native idle bounds on demand', async () => {
        const { mounted } = await mount();

        await flushLifecycle();
        nativeMock.window.resetSearchWindowBounds.mockClear();

        await mounted.result.resetSearchWindowBounds();

        expect(nativeMock.window.resetSearchWindowBounds).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('never repairs the idle height on its own', async () => {
        const { mounted, quickSearchOpen, sessionCount } = await mount();

        await flushLifecycle();
        nativeMock.window.resetSearchWindowBounds.mockClear();

        quickSearchOpen.value = true;
        await flushLifecycle();
        quickSearchOpen.value = false;
        await flushLifecycle();
        sessionCount.value = 1;
        await flushLifecycle();
        sessionCount.value = 0;
        await flushLifecycle();

        expect(nativeMock.window.resetSearchWindowBounds).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user sees the compact panel centered inside the stable viewport', async () => {
        const { mounted } = await mount();

        await flushLifecycle();

        expect(mounted.result.panelStyle.value).toMatchObject({
            position: 'fixed',
            width: 'auto',
            height: '60px',
            left: '48px',
            right: '48px',
            top: '510px',
            bottom: 'auto',
        });
        expect(mounted.result.panelStyle.value).not.toHaveProperty('top', 'calc(50% - 30px)');

        mounted.unmount();
    });

    it('user sees native bounds follow dragging and recovers the original size when cancelling', async () => {
        const { mounted } = await mount();

        await flushLifecycle();
        nativeMock.window.commitSearchPanelResize.mockClear();

        mounted.result.beginLogicalPanelResize();
        await mounted.result.previewLogicalPanelResize(
            { width: 760, height: 320 },
            { x: 10, y: 20 }
        );
        expect(mounted.result.cardHeight.value).toBe(320);

        await mounted.result.commitLogicalPanelResize();
        expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledTimes(1);
        expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledWith(
            expect.objectContaining({
                to: { width: 760, height: 320 },
                physicalOrigin: { x: 10, y: 0 },
                placement: 'preserve-origin',
            })
        );

        nativeMock.window.commitSearchPanelResize.mockClear();
        mounted.result.beginLogicalPanelResize();
        await mounted.result.previewLogicalPanelResize(
            { width: 800, height: 400 },
            { x: -30, y: -60 }
        );
        await mounted.result.cancelLogicalPanelResize({ x: 10, y: 20 });
        expect(lastCommit()).toMatchObject({
            to: { width: 760, height: 320 },
            physicalOrigin: { x: 10, y: 0 },
            auto: true,
            respectManualOverride: false,
        });
        expect(mounted.result.cardHeight.value).toBe(320);
        expect(mounted.result.isLogicalPanelResizing.value).toBe(false);

        mounted.unmount();
    });

    it('toggles the work-area placement when maximizing a bounded host', async () => {
        const { mounted } = await mount();

        await flushLifecycle();
        nativeMock.window.commitSearchPanelResize.mockClear();

        await mounted.result.toggleMaximize();

        expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledWith(
            expect.objectContaining({ placement: 'work-area' })
        );

        mounted.unmount();
    });

    it('user keeps the maximized window when an overlay triggers content measurement', async () => {
        const measured = createMeasuredElement(290);
        const { mounted, target, sessionCount } = await mount();
        sessionCount.value = 1;
        target.value = measured.element;
        await flushLifecycle();
        await mounted.result.toggleMaximize();
        nativeMock.window.commitSearchPanelResize.mockClear();

        measured.setHeight(900);
        await mounted.result.remeasureTargetHeight();

        expect(nativeMock.window.commitSearchPanelResize).not.toHaveBeenCalled();
        expect(mounted.result.effectiveWindowMaximized.value).toBe(true);
        mounted.unmount();
    });

    it('user returns to compact mode when a reset interrupts a delayed maximize', async () => {
        const { mounted } = await mount();
        await flushLifecycle();
        let acknowledge!: (state: ReturnType<typeof createWindowState>) => void;
        nativeMock.window.commitSearchPanelResize.mockImplementationOnce(
            () => new Promise((resolve) => (acknowledge = resolve))
        );
        const maximize = mounted.result.toggleMaximize();
        await flushLifecycle();
        const reset = mounted.result.resetSearchWindowBounds();
        acknowledge(createWindowState());
        await Promise.all([maximize, reset]);

        expect(mounted.result.effectiveWindowMaximized.value).toBe(false);
        expect(mounted.result.isLogicalPanelResizing.value).toBe(false);
        expect(mounted.result.cardHeight.value).toBe(60);
        await mounted.result.playSessionExpandAnimation(290);
        expect(mounted.result.cardHeight.value).toBe(290);
        mounted.unmount();
    });

    it('user keeps maximized mode when restoring idle bounds fails', async () => {
        const { mounted } = await mount();
        await flushLifecycle();
        await mounted.result.toggleMaximize();
        nativeMock.window.resetSearchWindowBounds.mockRejectedValueOnce(new Error('Host failed'));

        await mounted.result.resetSearchWindowBounds();

        expect(mounted.result.effectiveWindowMaximized.value).toBe(true);
        await mounted.result.toggleMaximize();
        expect(lastCommit()?.placement).toBe('restore');
        expect(mounted.result.effectiveWindowMaximized.value).toBe(false);
        mounted.unmount();
    });

    it('user keeps hidden bounds stable until the surface becomes visible again', async () => {
        const resizeEnabled = ref(false);
        const measured = createMeasuredElement(240);
        const { mounted, target } = await mount({ resizeEnabled });
        target.value = measured.element;
        await flushLifecycle();
        await mounted.result.remeasureTargetHeight();
        ResizeObserverMock.instances[0]?.emit(measured.element);
        await advanceMeasurementTimers();
        expect(mounted.result.cardHeight.value).toBe(60);

        nativeMock.window.resetSearchWindowBounds.mockClear();
        await mounted.result.resetSearchWindowBounds();
        expect(nativeMock.window.resetSearchWindowBounds).toHaveBeenCalledOnce();

        resizeEnabled.value = true;
        await flushLifecycle();
        await advanceMeasurementTimers();
        expect(mounted.result.cardHeight.value).toBe(240);
        mounted.unmount();
    });

    it('centres the surface when it grows on its own', async () => {
        const measured = createMeasuredElement(60);
        const { mounted, target, quickSearchOpen } = await mount();

        target.value = measured.element;
        await flushLifecycle();
        currentWindowMock.setPosition.mockClear();

        // The results list is the surface growing, not a popup: it keeps the centring.
        quickSearchOpen.value = true;
        measured.setHeight(240);
        ResizeObserverMock.instances[0]?.emit(measured.element);
        await advanceMeasurementTimers();
        await vi.advanceTimersByTimeAsync(SEARCH_SURFACE_MOTION.durationMs + 100);

        const style = mounted.result.panelStyle.value!;
        expect(Number.parseFloat(style.top) + mounted.result.cardHeight.value / 2).toBe(540);
        expect(currentWindowMock.setPosition).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('leaves the window alone when a popup owns the layout', async () => {
        const measured = createMeasuredElement(60);
        const overlayTarget = ref<HTMLElement | null>(createMeasuredElement(40).element);
        const { mounted, target } = await mount({ overlayTarget });

        target.value = measured.element;
        await flushLifecycle();
        currentWindowMock.setPosition.mockClear();

        measured.setHeight(240);
        ResizeObserverMock.instances[0]?.emit(measured.element);
        await advanceMeasurementTimers();
        await vi.advanceTimersByTimeAsync(SEARCH_SURFACE_MOTION.durationMs + 100);

        expect(currentWindowMock.setPosition).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('leaves the window alone for a popup that has not been measured yet', async () => {
        // The model picker flips its state before its element exists, so the growth that opens it
        // must already know a popup is there.
        const measured = createMeasuredElement(60);
        const overlayRequiredViewportHeight = ref(600);
        const { mounted, target } = await mount({ overlayRequiredViewportHeight });

        target.value = measured.element;
        await flushLifecycle();
        currentWindowMock.setPosition.mockClear();

        measured.setHeight(240);
        ResizeObserverMock.instances[0]?.emit(measured.element);
        await advanceMeasurementTimers();
        await vi.advanceTimersByTimeAsync(SEARCH_SURFACE_MOTION.durationMs + 100);

        expect(currentWindowMock.setPosition).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user keeps the card reveal running when an overlay reserves more space', async () => {
        const card = createAnimatedCard(60);
        const overlayRequiredViewportHeight = ref<number | null>(null);
        const { mounted } = await mount({
            card: ref(card.element),
            overlayRequiredViewportHeight,
        });
        await flushLifecycle();

        await mounted.result.playSessionExpandAnimation(290);
        await vi.advanceTimersByTimeAsync(50);
        overlayRequiredViewportHeight.value = 600;
        await mounted.result.playSessionExpandAnimation(290);

        expect(mounted.result.isSessionExpandAnimating.value).toBe(true);
        card.animations[0]!.finish();
        await flushLifecycle();
        await vi.advanceTimersByTimeAsync(SEARCH_SURFACE_MOTION.durationMs + 20);
        expect(mounted.result.isCardGrowing.value).toBe(false);
        expect(card.animations[0]!.cancel).toHaveBeenCalled();
        mounted.unmount();
    });

    it('user gets a stable window after an overlay finishes reserving space', async () => {
        const measured = createMeasuredElement(60);
        const overlayRequiredViewportHeight = ref<number | null>(null);
        const { mounted, target } = await mount({ overlayRequiredViewportHeight });
        target.value = measured.element;
        await flushLifecycle();

        overlayRequiredViewportHeight.value = 600;
        await mounted.result.playSessionExpandAnimation(60);
        nativeMock.window.commitSearchPanelResize.mockClear();
        await vi.advanceTimersByTimeAsync(500);

        expect(nativeMock.window.commitSearchPanelResize).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('user keeps the manual size when an older expansion acknowledgement arrives late', async () => {
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        let acknowledgeExpansion!: (state: ReturnType<typeof createWindowState>) => void;
        nativeMock.window.commitSearchPanelResize.mockImplementationOnce(
            () => new Promise((resolve) => (acknowledgeExpansion = resolve))
        );

        const expansion = mounted.result.playSessionExpandAnimation(290);
        await flushLifecycle();
        mounted.result.beginLogicalPanelResize();
        mounted.result.previewLogicalPanelResize({ width: 800, height: 400 });
        const manualResize = mounted.result.commitLogicalPanelResize();
        await flushLifecycle();
        acknowledgeExpansion(createWindowState({ currentHeight: 290 }));
        await Promise.all([expansion, manualResize]);

        expect(mounted.result.currentHeight.value).toBe(400);
        expect(mounted.result.cardHeight.value).toBe(400);
        expect(mounted.result.isSessionExpandAnimating.value).toBe(false);
        expect(card.animations).toHaveLength(0);
        mounted.unmount();
    });

    it('user keeps the manual frame when interrupting a card reveal', async () => {
        let origin = { x: 0, y: 0 };
        currentWindowMock.outerPosition.mockImplementation(async () => origin);
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        const expansion = mounted.result.playSessionExpandAnimation(290);
        await flushLifecycle();
        nativeMock.window.commitSearchPanelResize.mockImplementationOnce(
            async ({ to, physicalOrigin }) => {
                origin = physicalOrigin;
                return createWindowState({ currentWidth: to.width, currentHeight: to.height });
            }
        );
        mounted.result.beginLogicalPanelResize();
        const preview = mounted.result.previewLogicalPanelResize(
            { width: 800, height: 400 },
            { x: 200, y: 300 }
        );
        const manualResize = mounted.result.commitLogicalPanelResize();
        await flushLifecycle();
        await Promise.all([expansion, preview, manualResize]);
        await vi.advanceTimersByTimeAsync(500);

        expect(origin).toEqual({ x: 200, y: 0 });
        expect(Number.parseFloat(mounted.result.panelStyle.value!.top)).toBe(396);
        expect(mounted.result.cardHeight.value).toBe(400);
        mounted.unmount();
    });

    it('user keeps the dragged centre when an expanded conversation grows again', async () => {
        let origin = { x: 0, y: 0 };
        currentWindowMock.outerPosition.mockImplementation(async () => origin);
        currentWindowMock.setPosition.mockImplementation(async (position) => {
            origin = { x: position.x, y: position.y };
        });
        const { mounted } = await mount();
        await flushLifecycle();
        await mounted.result.playSessionExpandAnimation(290);
        await vi.advanceTimersByTimeAsync(400);
        origin = { x: 200, y: 85 };
        windowMoveMock.emit(origin.x, origin.y);
        await mounted.result.playSessionExpandAnimation(320);
        await vi.advanceTimersByTimeAsync(400);

        expect(origin).toEqual({ x: 200, y: 85 });
        expect(origin.y + Number.parseFloat(mounted.result.panelStyle.value!.top) + 320 / 2).toBe(
            625
        );
        mounted.unmount();
    });

    it.each([
        { hostY: 300, top: 0, bottom: 732 },
        { hostY: -300, top: 300, bottom: 1032 },
    ])(
        'keeps overlays inside the visible work area after dragging the host to $hostY',
        async ({ hostY, top, bottom }) => {
            currentWindowMock.outerPosition.mockResolvedValue({ x: 0, y: hostY });
            const { mounted } = await mount();
            await flushLifecycle();
            expect(mounted.result.overlayMinViewportTop.value).toBe(top);
            expect(mounted.result.overlayMaxViewportHeight.value).toBe(bottom);
            mounted.unmount();
        }
    );

    it('user keeps a manually sized conversation visible after dragging the host down', async () => {
        const { mounted, sessionCount } = await mount();
        sessionCount.value = 1;
        let state = createWindowState({
            currentHeight: 660,
            heightMode: SearchWindowHeightMode.ManualOverride,
        });
        nativeMock.window.getSearchWindowState.mockImplementation(async () => state);
        nativeMock.window.commitSearchPanelResize.mockImplementation(
            async ({ to, auto, respectManualOverride = true }) => {
                if (
                    auto &&
                    respectManualOverride &&
                    state.heightMode === SearchWindowHeightMode.ManualOverride
                )
                    return state;
                state = {
                    ...state,
                    currentHeight: to.height,
                    heightMode: auto
                        ? SearchWindowHeightMode.Auto
                        : SearchWindowHeightMode.ManualOverride,
                };
                return state;
            }
        );
        await mounted.result.syncWindowState();
        currentWindowMock.outerPosition.mockResolvedValue({ x: 0, y: 500 });
        windowMoveMock.emit(0, 500);
        await vi.advanceTimersByTimeAsync(200);
        expect(
            500 +
                Number.parseFloat(mounted.result.panelStyle.value!.top) +
                mounted.result.cardHeight.value
        ).toBeLessThanOrEqual(1080);
        expect(state.heightMode).toBe(SearchWindowHeightMode.ManualOverride);
        mounted.unmount();
    });

    it('user drags to the screen edge without the card resizing or moving inside the host', async () => {
        const { mounted } = await mount();
        await mounted.result.playSessionExpandAnimation(660);
        nativeMock.window.getSearchWindowState.mockResolvedValue(
            createWindowState({ currentHeight: 660 })
        );
        await mounted.result.prepareForNativeDrag();
        const initial = { ...mounted.result.panelStyle.value };
        nativeMock.window.commitSearchPanelResize.mockClear();
        for (const y of [500, 900, 1030]) {
            currentWindowMock.outerPosition.mockResolvedValue({ x: 0, y });
            windowMoveMock.emit(0, y);
            await vi.advanceTimersByTimeAsync(100);
            expect(mounted.result.panelStyle.value).toEqual(initial);
            expect(mounted.result.cardHeight.value).toBe(660);
            expect(nativeMock.window.commitSearchPanelResize).not.toHaveBeenCalled();
        }
        mounted.unmount();
    });

    it('user keeps content mounted until a fallback bounds reset finishes animating', async () => {
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await mounted.result.playSessionExpandAnimation(290);
        card.animations[0]!.finish();
        await flushLifecycle();
        card.setHeight(290);
        let settled = false;
        const reset = mounted.result.resetSearchWindowBounds().then(() => {
            settled = true;
        });
        await flushLifecycle();
        expect(settled).toBe(false);
        card.animations[1]!.finish();
        await reset;
        expect(settled).toBe(true);
        mounted.unmount();
    });

    it('user keeps content mounted when a second close arrives during the same fold', async () => {
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        await mounted.result.playSessionExpandAnimation(290);
        card.animations[0]!.finish();
        await flushLifecycle();
        card.setHeight(290);
        const first = mounted.result.collapseSessionToIdle();
        await flushLifecycle();
        let closed = false;
        const second = mounted.result.collapseSessionToIdle().then(() => {
            closed = true;
        });
        await flushLifecycle();
        const closedBeforeFold = closed;
        card.animations[1]!.finish();
        await Promise.all([first, second]);
        mounted.unmount();
        expect(closedBeforeFold).toBe(false);
    });

    it('user releases an edge drag and recovers a usable panel without a resize loop', async () => {
        const { mounted, sessionCount } = await mount();
        sessionCount.value = 1;
        let state = createWindowState({
            currentHeight: 660,
            heightMode: SearchWindowHeightMode.ManualOverride,
        });
        let origin = { x: 0, y: 0 };
        currentWindowMock.outerPosition.mockImplementation(async () => origin);
        nativeMock.window.getSearchWindowState.mockImplementation(async () => state);
        nativeMock.window.commitSearchPanelResize.mockImplementation(
            async ({ to, auto, placement }) => {
                if (placement === 'idle') origin = { x: 0, y: 0 };
                if (!auto) state = { ...state, currentHeight: Math.max(60, to.height) };
                return state;
            }
        );
        await mounted.result.syncWindowState();
        await mounted.result.prepareForNativeDrag();
        origin = { x: 0, y: 1060 };
        windowMoveMock.emit(0, 1060);
        await vi.advanceTimersByTimeAsync(200);
        expect(mounted.result.cardHeight.value).toBe(660);
        await mounted.result.finishNativeDrag();
        await vi.advanceTimersByTimeAsync(200);
        expect(
            origin.y +
                Number.parseFloat(mounted.result.panelStyle.value!.top) +
                mounted.result.cardHeight.value
        ).toBeLessThanOrEqual(1080);
        expect(state.heightMode).toBe(SearchWindowHeightMode.ManualOverride);
        nativeMock.window.commitSearchPanelResize.mockClear();
        await vi.advanceTimersByTimeAsync(500);
        expect(nativeMock.window.commitSearchPanelResize).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('user keeps the conversation centre across a delayed native acknowledgement', async () => {
        const origin = { x: 0, y: 0 };
        currentWindowMock.outerPosition.mockImplementation(async () => origin);
        currentMonitorMock.mockResolvedValue({
            workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
        });
        const { mounted } = await mount();
        await flushLifecycle();
        nativeMock.window.commitSearchPanelResize.mockImplementationOnce(async ({ to }) => {
            await new Promise((resolve) => setTimeout(resolve, 24));
            windowMoveMock.emit(origin.x, origin.y);
            const state = createWindowState({ currentHeight: to.height });
            nativeMock.window.getSearchWindowState.mockResolvedValue(state);
            return state;
        });
        const expansion = mounted.result.playSessionExpandAnimation(660);
        await vi.advanceTimersByTimeAsync(500);
        await expansion;

        expect(origin.y + Number.parseFloat(mounted.result.panelStyle.value!.top) + 660 / 2).toBe(
            540
        );
        mounted.unmount();
    });

    it.each([
        { top: 0, height: 1080, scale: 1, startY: 0 },
        { top: -900, height: 900, scale: 1.5, startY: -850 },
        { top: 0, height: 1080, scale: 1, startY: 900 },
    ])(
        'keeps an expanding surface inside its monitor work area ($startY, $scale DPI)',
        async ({ top, height, scale, startY }) => {
            let origin = { x: 0, y: startY };
            currentWindowMock.outerPosition.mockImplementation(async () => origin);
            currentWindowMock.setPosition.mockImplementation(async (position) => {
                origin = { ...position };
            });
            vi.stubGlobal('innerHeight', height / scale);
            currentWindowMock.outerSize.mockResolvedValue({ width: 846, height });
            currentMonitorMock.mockResolvedValue({
                workArea: { position: { x: 0, y: top }, size: { width: 1920, height } },
            });
            const { mounted } = await mount();
            await flushLifecycle();
            windowScaleMock.emit(scale);
            windowMoveMock.emit(0, startY);

            await mounted.result.playSessionExpandAnimation(660);
            await vi.advanceTimersByTimeAsync(400);

            const panelTop =
                origin.y + Number.parseFloat(mounted.result.panelStyle.value!.top) * scale;
            const panelBottom = panelTop + mounted.result.cardHeight.value * scale;
            expect(origin.y).toBe(startY);
            expect(panelTop).toBeGreaterThanOrEqual(top);
            expect(panelBottom).toBeLessThanOrEqual(top + height);
            mounted.unmount();
        }
    );

    it('user keeps the previous position and size when collapsing the native window fails', async () => {
        let origin = { x: 0, y: 500 };
        currentWindowMock.outerPosition.mockImplementation(async () => origin);
        currentWindowMock.setPosition.mockImplementation(async (position) => {
            origin = { x: position.x, y: position.y };
        });
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        await mounted.result.playSessionExpandAnimation(290);
        card.animations[0]!.finish();
        await vi.advanceTimersByTimeAsync(400);
        const before = { ...origin };
        card.setHeight(290);
        nativeMock.window.commitSearchPanelResize.mockRejectedValueOnce(new Error('Host failed'));
        const collapse = mounted.result.collapseSessionToIdle();
        await flushLifecycle();
        await vi.advanceTimersByTimeAsync(400);
        await collapse;
        await vi.advanceTimersByTimeAsync(400);

        expect(origin).toEqual(before);
        expect(mounted.result.cardHeight.value).toBe(290);
        mounted.unmount();
    });

    it('user can resize again after a collapsed host commit fails', async () => {
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        await mounted.result.playSessionExpandAnimation(290);
        card.animations[0]!.finish();
        await flushLifecycle();
        await vi.advanceTimersByTimeAsync(SEARCH_SURFACE_MOTION.durationMs + 20);
        card.setHeight(290);
        nativeMock.window.commitSearchPanelResize.mockRejectedValueOnce(new Error('Host failed'));

        const collapse = mounted.result.collapseSessionToIdle();
        await flushLifecycle();
        expect(await collapse).toBe(false);

        expect(card.animations).toHaveLength(1);
        expect(mounted.result.cardHeight.value).toBe(290);
        expect(mounted.result.isSessionExpandAnimating.value).toBe(false);
        expect(mounted.result.isCardGrowing.value).toBe(false);
        mounted.unmount();
    });

    it('user keeps a usable compact panel without repeated requests when dragged near the work-area bottom', async () => {
        currentWindowMock.outerPosition.mockResolvedValue({ x: 0, y: 900 });
        const { mounted, target, quickSearchOpen } = await mount();
        await flushLifecycle();
        nativeMock.window.commitSearchPanelResize.mockImplementation(async ({ to }) =>
            createWindowState({ currentHeight: Math.max(60, to.height) })
        );
        nativeMock.window.commitSearchPanelResize.mockClear();
        quickSearchOpen.value = true;
        target.value = createMeasuredElement(290).element;
        await flushLifecycle();
        await vi.advanceTimersByTimeAsync(100);
        const calls = nativeMock.window.commitSearchPanelResize.mock.calls.length;
        await vi.advanceTimersByTimeAsync(100);
        expect(nativeMock.window.commitSearchPanelResize.mock.calls.length).toBe(calls);
        expect(mounted.result.cardHeight.value).toBeGreaterThanOrEqual(60);
        expect(
            Number.parseFloat(mounted.result.panelStyle.value!.top) +
                mounted.result.cardHeight.value
        ).toBeLessThanOrEqual(180);
        mounted.unmount();
    });

    it('user gets the editor back inside the work area when the dragged host cannot fit it', async () => {
        const { mounted, target, quickSearchOpen } = await mount();
        await flushLifecycle();
        currentWindowMock.outerPosition.mockResolvedValue({ x: 0, y: 1050 });
        windowMoveMock.emit(0, 1050);
        await vi.advanceTimersByTimeAsync(100);
        nativeMock.window.commitSearchPanelResize.mockImplementation(async ({ to, placement }) => {
            if (placement === 'idle')
                currentWindowMock.outerPosition.mockResolvedValue({ x: 0, y: 0 });
            return createWindowState({ currentHeight: Math.max(60, to.height) });
        });
        quickSearchOpen.value = true;
        target.value = createMeasuredElement(290).element;
        await flushLifecycle();
        await vi.advanceTimersByTimeAsync(100);
        expect(nativeMock.window.commitSearchPanelResize).toHaveBeenCalledWith(
            expect.objectContaining({ placement: 'idle' })
        );
        expect(mounted.result.cardHeight.value).toBe(290);
        const top = Number.parseFloat(mounted.result.panelStyle.value!.top);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top + mounted.result.cardHeight.value).toBeLessThanOrEqual(1080);
        mounted.unmount();
    });

    it('user finishes starting a new session when an overlay disappears during the fallback fold', async () => {
        const card = createAnimatedCard(60);
        const overlayTarget = ref<HTMLElement | null>(null);
        const { mounted, target, sessionCount } = await mount({
            card: ref(card.element),
            overlayTarget,
        });
        await flushLifecycle();
        await mounted.result.playSessionExpandAnimation(290);
        card.animations[0]!.finish();
        await flushLifecycle();
        card.setHeight(290);
        sessionCount.value = 1;
        target.value = createMeasuredElement(290).element;
        overlayTarget.value = createMeasuredElement(200).element;
        await flushLifecycle();
        expect(await mounted.result.collapseSessionToIdle()).toBe(false);

        const reset = mounted.result.resetSearchWindowBounds();
        await flushLifecycle();
        overlayTarget.value = null;
        await mounted.result.remeasureTargetHeight();
        await advanceMeasurementTimers();
        card.animations[1]!.finish();
        await flushLifecycle();

        expect(await reset).toBe(true);
        expect(mounted.result.cardHeight.value).toBe(60);
        mounted.unmount();
    });

    it('user completes a fallback fold even when native constraints acknowledge after its duration', async () => {
        const card = createAnimatedCard(60);
        const { mounted, target, sessionCount } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        sessionCount.value = 1;
        target.value = createMeasuredElement(290).element;
        await flushLifecycle();
        await mounted.result.playSessionExpandAnimation(290);
        card.animations[card.animations.length - 1]!.finish();
        await flushLifecycle();
        card.setHeight(290);
        let release!: () => void;
        nativeMock.window.setSearchWindowMinSize.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                })
        );
        const fold = mounted.result.resetSearchWindowBounds();
        await flushLifecycle();
        card.animations[card.animations.length - 1]!.finish();
        await vi.advanceTimersByTimeAsync(500);
        release();
        await flushLifecycle();
        card.animations[card.animations.length - 1]!.finish();
        await flushLifecycle();

        expect(await fold).toBe(true);
        expect(mounted.result.cardHeight.value).toBe(60);
        mounted.unmount();
    });

    it('user closes the view without leaving a running card animation', async () => {
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        await mounted.result.playSessionExpandAnimation(290);

        mounted.unmount();
        await flushLifecycle();

        expect(card.animations[0]!.cancel).toHaveBeenCalled();
        expect(mounted.result.isCardGrowing.value).toBe(false);
    });

    it('user keeps the previous card until the native transition region is ready', async () => {
        const card = createAnimatedCard(60);
        let releaseRegion!: () => void;
        const preparePanelTransition = vi.fn<() => Promise<void>>(async () => undefined);
        const { mounted } = await mount({ card: ref(card.element), preparePanelTransition });
        await flushLifecycle();
        preparePanelTransition.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseRegion = resolve;
                })
        );
        const expansion = mounted.result.playSessionExpandAnimation(290);
        await flushLifecycle();
        expect(mounted.result.cardHeight.value).toBe(60);
        expect(card.animations).toHaveLength(0);

        releaseRegion();
        await expansion;
        expect(card.animations).toHaveLength(1);
        card.animations[0]!.finish();
        await flushLifecycle();
        expect(mounted.result.cardHeight.value).toBe(290);
        mounted.unmount();
    });

    it('user who prefers reduced motion reaches the expanded size and position without intermediate frames', async () => {
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => ({
                matches: true,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            }))
        );
        let origin = { x: 0, y: 500 };
        currentWindowMock.outerPosition.mockImplementation(async () => origin);
        currentWindowMock.setPosition.mockImplementation(async (position) => {
            origin = { x: position.x, y: position.y };
        });
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        currentWindowMock.setPosition.mockClear();

        await mounted.result.playSessionExpandAnimation(290);
        await flushLifecycle();

        expect(mounted.result.cardHeight.value).toBe(290);
        expect(mounted.result.isSessionExpandAnimating.value).toBe(false);
        expect(card.animations).toHaveLength(0);
        expect(origin).toEqual({ x: 0, y: 500 });
        expect(currentWindowMock.setPosition).not.toHaveBeenCalled();
        mounted.unmount();
    });

    it('user closes the view before movement registration completes without leaving an active listener', async () => {
        let register!: (unlisten: () => void) => void;
        const unlisten = vi.fn();
        currentWindowMock.onMoved.mockReturnValueOnce(
            new Promise((resolve) => {
                register = resolve;
            })
        );
        const { mounted } = await mount();
        mounted.unmount();
        register(unlisten);
        await flushLifecycle();

        expect(unlisten).toHaveBeenCalledOnce();
    });
    it('user switches to reduced motion during a shrink and still reaches the final native size', async () => {
        let mediaListener!: (event: { matches: boolean }) => void;
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => ({
                matches: false,
                addEventListener: (_: string, listener: typeof mediaListener) => {
                    mediaListener = listener;
                },
                removeEventListener: vi.fn(),
            }))
        );
        const card = createAnimatedCard(60);
        const { mounted } = await mount({ card: ref(card.element) });
        await flushLifecycle();
        await mounted.result.playSessionExpandAnimation(290);
        card.animations[0]!.finish();
        await flushLifecycle();
        card.setHeight(290);
        const collapse = mounted.result.collapseSessionToIdle();
        await flushLifecycle();
        mediaListener({ matches: true });
        await collapse;
        await vi.advanceTimersByTimeAsync(40);
        expect(mounted.result.cardHeight.value).toBe(60);
        expect(mounted.result.isSessionExpandAnimating.value).toBe(false);
        expect(mounted.result.isCardGrowing.value).toBe(false);
        mounted.unmount();
    });
});
