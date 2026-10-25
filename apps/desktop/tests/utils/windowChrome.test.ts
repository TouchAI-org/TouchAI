import { beforeEach, describe, expect, it, vi } from 'vitest';

const onResized = vi.fn();
const currentMonitor = vi.fn();
const scaleFactor = vi.fn();

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ scaleFactor, onResized }),
    currentMonitor: () => currentMonitor(),
}));

const { applyDesktopPlatformClass, initializeDesktopShell } = await import('@/utils/windowChrome');
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
    onResized.mockReset();
    currentMonitor.mockReset();
    scaleFactor.mockReset();
    scaleFactor.mockResolvedValue(1);
    currentMonitor.mockResolvedValue(monitorOf(1400, 900));
    stubViewport(750, 60);
}

describe('detectDesktopPlatform', () => {
    beforeEach(resetShellState);

    it('detects Linux from the WebKitGTK user agent', () => {
        stubUserAgent(LINUX_UA);
        expect(detectDesktopPlatform()).toBe('linux');
    });

    it('detects Windows and macOS', () => {
        stubUserAgent(WINDOWS_UA);
        expect(detectDesktopPlatform()).toBe('windows');

        stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
        expect(detectDesktopPlatform()).toBe('macos');
    });

    it('reports unknown for an unrecognised user agent', () => {
        stubUserAgent('SomeOtherAgent/1.0');
        expect(detectDesktopPlatform()).toBe('unknown');
    });

    it('marks the document root so the Linux-only shell CSS can apply', () => {
        stubUserAgent(LINUX_UA);
        applyDesktopPlatformClass();

        expect(document.documentElement.dataset.platform).toBe('linux');
    });
});

describe('initializeDesktopShell', () => {
    beforeEach(resetShellState);

    it('does not touch the shell state on platforms with native rounded corners', () => {
        stubUserAgent(WINDOWS_UA);

        initializeDesktopShell();

        expect(document.documentElement.dataset.platform).toBe('windows');
        expect(onResized).not.toHaveBeenCalled();
        expect(currentMonitor).not.toHaveBeenCalled();
    });

    it('keeps the radius for a normal floating window', async () => {
        stubUserAgent(LINUX_UA);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('false');
        });
    });

    it('drops the radius when the window fills the monitor', async () => {
        stubUserAgent(LINUX_UA);
        stubViewport(1400, 900);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('drops the radius for a fullscreen window that reports no maximize state', async () => {
        // sway 在 Wayland 下全屏时 isMaximized()/isFullscreen() 都是 false，
        // 只有窗口尺寸等于显示器尺寸这一个可靠信号。
        stubUserAgent(LINUX_UA);
        stubViewport(1400, 900);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('compares against logical monitor size on a scaled display', async () => {
        stubUserAgent(LINUX_UA);
        scaleFactor.mockResolvedValue(2);
        currentMonitor.mockResolvedValue(monitorOf(2800, 1800));
        stubViewport(1400, 900);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('re-reads the state after the window is resized', async () => {
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

    it('keeps the radius when the monitor cannot be resolved', async () => {
        stubUserAgent(LINUX_UA);
        currentMonitor.mockResolvedValue(null);
        stubViewport(1400, 900);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('false');
        });
    });
});
