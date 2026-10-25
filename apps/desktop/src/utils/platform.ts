// Copyright (c) 2026. 千诚. Licensed under GPL v3.

export type DesktopPlatform = 'linux' | 'macos' | 'windows' | 'unknown';

/**
 * 解析桌面平台。WebKitGTK / WebView2 / WKWebView 都会在 navigator.platform
 * 与 userAgent 里带上稳定的平台标识，无需额外依赖。
 */
export function detectDesktopPlatform(): DesktopPlatform {
    const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase();

    if (platform.includes('linux') || platform.includes('x11')) {
        return 'linux';
    }

    if (platform.includes('mac')) {
        return 'macos';
    }

    if (platform.includes('win')) {
        return 'windows';
    }

    return 'unknown';
}

export const isLinuxDesktop = (): boolean => detectDesktopPlatform() === 'linux';
