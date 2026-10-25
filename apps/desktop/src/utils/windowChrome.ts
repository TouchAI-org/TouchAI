// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';

import { detectDesktopPlatform, isLinuxDesktop } from './platform';

/**
 * 让文档根节点带上平台标记，供 CSS 选择窗口外壳样式。
 * 必须在首帧渲染前同步执行，否则会先画出直角再变成圆角。
 */
export function applyDesktopPlatformClass(): void {
    document.documentElement.dataset.platform = detectDesktopPlatform();
}

/**
 * 判断窗口是否铺满它所在的显示器。
 *
 * 窗口最大化或全屏后贴住屏幕边缘，此时保留圆角会在四角露出桌面；
 * 全屏时窗口下方没有桌面，四角会直接变成黑色。
 *
 * 不能只依赖 `isMaximized()` / `isFullscreen()`：sway 在 Wayland 下全屏时两者
 * 都返回 false（已实测），而窗口尺寸已经等于显示器尺寸。因此以尺寸比对为准，
 * 用 `currentMonitor()` 而不是 `screen`，多显示器下才能拿到窗口所在的那块屏。
 */
async function coversWholeMonitor(
    currentWindow: ReturnType<typeof getCurrentWindow>
): Promise<boolean> {
    const [monitor, scaleFactor] = await Promise.all([
        currentMonitor().catch(() => null),
        currentWindow.scaleFactor().catch(() => 1),
    ]);

    if (!monitor) {
        return false;
    }

    const monitorWidth = monitor.size.width / scaleFactor;
    const monitorHeight = monitor.size.height / scaleFactor;

    // 窗口边框可能带来 1px 级别偏差，留 2px 容差避免抖动。
    return window.innerWidth >= monitorWidth - 2 && window.innerHeight >= monitorHeight - 2;
}

function syncEdgeToEdgeShellState(): void {
    let currentWindow: ReturnType<typeof getCurrentWindow>;

    try {
        currentWindow = getCurrentWindow();
    } catch {
        return;
    }

    const apply = async (): Promise<void> => {
        const edgeToEdge = await coversWholeMonitor(currentWindow);
        document.documentElement.dataset.windowMaximized = String(edgeToEdge);
    };

    void apply();
    void currentWindow.onResized(() => {
        void apply();
    });
}

export function initializeDesktopShell(): void {
    applyDesktopPlatformClass();

    if (isLinuxDesktop()) {
        syncEdgeToEdgeShellState();
    }
}
