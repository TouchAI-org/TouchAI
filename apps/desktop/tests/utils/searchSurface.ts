import { vi } from 'vitest';

import { SearchWindowHeightMode } from '@/config/searchWindow';
import type {
    SearchPanelResizeCommit,
    SearchSurfacePreparation,
    SearchWindowRegionUpdate,
    SearchWindowState,
} from '@/services/NativeService/types';

import { mockTauriCommand } from './tauri';

const viewport = { x: 0, y: 0, width: 846, height: 1080 };

export const searchSurfaceWindow = {
    label: 'main',
    isVisible: async () => true,
    isAlwaysOnTop: async () => false,
    isMaximized: async () => false,
    isFullscreen: async () => false,
    scaleFactor: async () => 1,
    outerPosition: async () => ({ x: 0, y: 0, toLogical: () => ({ x: 0, y: 0 }) }),
    outerSize: async () => ({ ...viewport, toLogical: () => viewport }),
    innerSize: async () => ({ ...viewport, toLogical: () => viewport }),
    onResized: async () => () => undefined,
    onMoved: async () => () => undefined,
    onScaleChanged: async () => () => undefined,
};

export const searchSurfaceMonitor = {
    size: { width: 1920, height: 1080 },
    position: { x: 0, y: 0 },
    workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
    scaleFactor: 1,
};

export function acknowledgeSearchRegions(payload: unknown): SearchWindowRegionUpdate {
    const { generation, preparation } = payload as {
        generation: number;
        preparation?: SearchSurfacePreparation;
    };
    return {
        status: 'applied',
        generation,
        ...(preparation
            ? {
                  showStatus: {
                      status: 'shown' as const,
                      rendererEpoch: preparation.rendererEpoch,
                      showEpoch: preparation.showEpoch,
                      hostEpoch: preparation.hostEpoch,
                      generation,
                  },
              }
            : {}),
    };
}

/** Physical geometry and IPC acknowledgements; all renderer orchestration stays real. */
export function installSearchSurfaceBoundary() {
    vi.stubGlobal('innerWidth', viewport.width);
    vi.stubGlobal('innerHeight', viewport.height);
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(viewport.width);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(viewport.height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
    ) {
        return this.hasAttribute('data-search-overlay-host')
            ? new DOMRect(48, 161, 400, 384)
            : new DOMRect(48, 96, 750, 60);
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    const state: SearchWindowState = {
        defaults: { width: 750, height: 60 },
        currentWidth: 750,
        currentHeight: 60,
        heightMode: SearchWindowHeightMode.Auto,
        monitorHost: true,
    };
    mockTauriCommand('get_search_window_state', () => ({ ...state }));
    mockTauriCommand('set_search_window_defaults', (payload: unknown) => {
        return (payload as { defaults: SearchWindowState['defaults'] }).defaults;
    });
    mockTauriCommand('commit_search_panel_resize', (payload: unknown) => {
        const { resize } = payload as { resize: SearchPanelResizeCommit };
        state.currentWidth = resize.to.width;
        state.currentHeight = resize.to.height;
        return { ...state };
    });
    mockTauriCommand('get_search_window_renderer_epoch', 1);
    mockTauriCommand('mark_search_window_ready', {
        rendererEpoch: 1,
        showEpoch: 1,
        hostEpoch: 1,
        source: 'main',
        physicalViewport: viewport,
        scaleFactor: 1,
    } satisfies SearchSurfacePreparation);
    mockTauriCommand('set_search_window_regions', acknowledgeSearchRegions);
}
