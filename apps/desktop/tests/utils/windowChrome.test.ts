import { beforeEach, describe, expect, it, vi } from 'vitest';

const onResized = vi.fn();
const isMaximized = vi.fn();

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ isMaximized, onResized }),
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

const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

describe('detectDesktopPlatform', () => {
    beforeEach(() => {
        delete document.documentElement.dataset.platform;
        delete document.documentElement.dataset.windowMaximized;
        onResized.mockReset();
        isMaximized.mockReset();
        isMaximized.mockResolvedValue(false);
    });

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
    beforeEach(() => {
        delete document.documentElement.dataset.platform;
        delete document.documentElement.dataset.windowMaximized;
        onResized.mockReset();
        isMaximized.mockReset();
        isMaximized.mockResolvedValue(false);
    });

    it('does not touch the maximize state on platforms with native rounded corners', () => {
        stubUserAgent(WINDOWS_UA);

        initializeDesktopShell();

        expect(document.documentElement.dataset.platform).toBe('windows');
        expect(onResized).not.toHaveBeenCalled();
    });

    it('tracks the maximize state on Linux so a maximized window drops its radius', async () => {
        stubUserAgent(LINUX_UA);
        isMaximized.mockResolvedValue(true);

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
        expect(onResized).toHaveBeenCalledTimes(1);
    });

    it('re-reads the maximize state after the window is resized', async () => {
        stubUserAgent(LINUX_UA);
        isMaximized.mockResolvedValue(false);

        initializeDesktopShell();
        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('false');
        });

        const resizeHandler = onResized.mock.calls[0]?.[0] as () => void;
        isMaximized.mockResolvedValue(true);
        resizeHandler();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('true');
        });
    });

    it('treats an unreadable maximize state as not maximized', async () => {
        stubUserAgent(LINUX_UA);
        isMaximized.mockRejectedValue(new Error('window gone'));

        initializeDesktopShell();

        await vi.waitFor(() => {
            expect(document.documentElement.dataset.windowMaximized).toBe('false');
        });
    });
});
