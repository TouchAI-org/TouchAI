// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { getCurrentWindow } from '@tauri-apps/api/window';

import { detectDesktopPlatform, isLinuxDesktop } from './platform';

/**
 * 让文档根节点带上平台标记，供 CSS 选择窗口外壳样式。
 * 必须在首帧渲染前同步执行，否则会先画出直角再变成圆角。
 */
export function applyDesktopPlatformClass(): void {
    document.documentElement.dataset.platform = detectDesktopPlatform();
}

/**
 * Linux 窗口是透明的，圆角由 #app 自己裁剪。窗口最大化后贴住屏幕边缘，
 * 再保留圆角就会在四角露出桌面，因此需要同步最大化状态。
 */
function syncMaximizedShellState(): void {
    let currentWindow: ReturnType<typeof getCurrentWindow>;

    try {
        currentWindow = getCurrentWindow();
    } catch {
        return;
    }

    const apply = async (): Promise<void> => {
        const maximized = await currentWindow.isMaximized().catch(() => false);
        document.documentElement.dataset.windowMaximized = String(maximized);
    };

    void apply();
    void currentWindow.onResized(() => {
        void apply();
    });
}

export function initializeDesktopShell(): void {
    applyDesktopPlatformClass();

    if (isLinuxDesktop()) {
        syncMaximizedShellState();
    }
}
