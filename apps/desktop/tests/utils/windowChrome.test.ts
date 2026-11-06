import { beforeEach, describe, expect, it, vi } from 'vitest';

const onResized = vi.fn();
const currentMonitor = vi.fn();
const scaleFactor = vi.fn();
const isMaximized = vi.fn();
const isFullscreen = vi.fn();

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ scaleFactor, onResized, isMaximized, isFullscreen }),
    currentMonitor: () => currentMonitor(),
}));

const {
    applyDesktopPlatformClass,
    initializeDesktopShell,
    readWindowSurfaceBounds,
    readWindowViewportBounds,
} = await import('@/utils/windowChrome');
const { detectDesktopPlatform } = await import('@/utils/platform');

function stubUserAgent(userAgent: string, platform = '') {
    Object.defineProperty(window.navigator, 'userAgent', {
        value: userAgent,
        configurable: true,
    });
    Object.defineProperty(window.navigator, 'platform', {
        value: platform,
        configurable: true,
    });
}

function stubViewport(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function monitorOf(width: number, height: number) {
    return { size: { width, height } };
}

function resetShellState() {
    delete document.documentElement.dataset.platform;
    delete document.documentElement.dataset.windowMaximized;
    document.querySelector('.window-shell')?.remove();
    onResized.mockReset();
    currentMonitor.mockReset();
    scaleFactor.mockReset();
    isMaximized.mockReset();
    isFullscreen.mockReset();
    scaleFactor.mockResolvedValue(1);
    isMaximized.mockResolvedValue(false);
    isFullscreen.mockResolvedValue(false);
    currentMonitor.mockResolvedValue(monitorOf(1400, 900));
    stubViewport(750, 60);
}

describe('window surface bounds', () => {
    beforeEach(resetShellState);

    it('user gets the visible shell instead of the native shadow gutter', () => {
        const shell = document.createElement('div');
        shell.className = 'window-shell';
        shell.getBoundingClientRect = () => new DOMRect(24, 24, 312, 100);
        document.body.append(shell);
        stubViewport(360, 148);

        expect(readWindowSurfaceBounds()).toEqual({
            left: 24,
            top: 24,
            right: 336,
            bottom: 124,
            width: 312,
            height: 100,
        });
        expect(readWindowViewportBounds()).toEqual(readWindowSurfaceBounds());
    });

    it('user gets the viewport when the shell has not been laid out yet', () => {
        const shell = document.createElement('div');
        shell.className = 'window-shell';
        shell.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
        document.body.append(shell);
        stubViewport(750, 60);

        expect(readWindowSurfaceBounds()).toBeNull();
        expect(readWindowViewportBounds()).toMatchObject({ width: 750, height: 60 });
    });
});

describe('detectDesktopPlatform', () => {
    beforeEach(resetShellState);

    it('user sees Linux detected from the WebKitGTK user agent', () => {
        stubUserAgent(LINUX_UA);
        expect(detectDesktopPlatform()).toBe('linux');
    });

    it('user sees Windows and macOS detected', () => {
        stubUserAgent(WINDOWS_UA);
        expect(detectDesktopPlatform()).toBe('windows');

        stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
        expect(detectDesktopPlatform()).toBe('macos');
    });

    it('user sees an unrecognised user agent reported as unknown', () => {
        stubUserAgent('SomeOtherAgent/1.0');
        expect(detectDesktopPlatform()).toBe('unknown');
    });

    it('user gets a document marker so the shared shell CSS can apply', () => {
        stubUserAgent(LINUX_UA);
        applyDesktopPlatformClass();

        expect(document.documentElement.dataset.platform).toBe('linux');
    });
});

describe('initializeDesktopShell', () => {
    beforeEach(resetShellState);

    it('user gets the shared shell state tracked on Windows too', async () => {
        stubUserAgent(WINDOWS_UA);

        initializeDesktopShell();

        expect(document.documentElement.dataset.platform).toBe('windows');
        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('false');
        });
        expect(onResized).toHaveBeenCalled();
        expect(currentMonitor).toHaveBeenCalled();
    });

    it('user keeps the radius for a normal floating window', async () => {
        stubUserAgent(LINUX_UA);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('false');
        });
    });

    it('user loses the radius when the window fills the monitor', async () => {
        stubUserAgent(LINUX_UA);
        stubViewport(1400, 900);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('user loses the radius for a fullscreen window that fills the monitor', async () => {
        stubUserAgent(LINUX_UA);
        stubViewport(1400, 900);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('user loses the radius when the platform reports a maximized window', async () => {
        stubUserAgent(WINDOWS_UA);
        isMaximized.mockResolvedValue(true);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('user loses the radius when the platform reports a fullscreen window', async () => {
        stubUserAgent(LINUX_UA);
        isFullscreen.mockResolvedValue(true);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('user gets the size fallback when the platform cannot report either window state', async () => {
        stubUserAgent(WINDOWS_UA);
        isMaximized.mockRejectedValue(new Error('maximize state unavailable'));
        isFullscreen.mockRejectedValue(new Error('fullscreen state unavailable'));
        stubViewport(1400, 900);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('user gets monitor bounds compared in logical pixels on a scaled display', async () => {
        stubUserAgent(LINUX_UA);
        scaleFactor.mockResolvedValue(2);
        currentMonitor.mockResolvedValue(monitorOf(2800, 1800));
        stubViewport(1400, 900);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('user gets the shell state re-read after the window is resized', async () => {
        stubUserAgent(LINUX_UA);

        initializeDesktopShell();
        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('false');
        });

        const resizeHandler = onResized.mock.calls[0]?.[0] as () => void;
        stubViewport(1400, 900);
        resizeHandler();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('user keeps the radius when the monitor cannot be resolved', async () => {
        stubUserAgent(LINUX_UA);
        currentMonitor.mockResolvedValue(null);
        stubViewport(1400, 900);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('false');
        });
    });
});
