// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { AppEvent, eventService } from '@services/EventService';
import { paths } from '@services/NativeService';
import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * 字体文件名
 */
const FONT_FILENAME = 'SourceHanSerifSC-VF.ttf.woff2';
const FONT_FACE_FAMILY = 'TouchAI Source Han Serif SC';
const FONT_FACE_STYLE_ATTRIBUTE = 'data-touchai-font-face';
const FONT_FACE_STYLE_KEY = 'source-han-serif-sc';

let fontLoadPromise: Promise<void> | null = null;
let fontReadyListenerPromise: Promise<void> | null = null;
let fontReloadToken = 0;

interface LoadFontFaceOptions {
    refresh?: boolean;
}

function getInjectedFontFaceStyle(): HTMLStyleElement | null {
    return document.head.querySelector<HTMLStyleElement>(
        `style[${FONT_FACE_STYLE_ATTRIBUTE}="${FONT_FACE_STYLE_KEY}"]`
    );
}

function hasInjectedFontFace(): boolean {
    return getInjectedFontFaceStyle() !== null;
}

function appendFontReloadToken(fontUrl: string, reloadToken: number): string {
    const separator = fontUrl.includes('?') ? '&' : '?';
    return `${fontUrl}${separator}touchaiFontReload=${reloadToken}`;
}

/**
 * 加载字体文件并注入 @font-face 规则
 */
async function injectFontFace(options: LoadFontFaceOptions = {}): Promise<void> {
    const { refresh = false } = options;

    if (!refresh && hasInjectedFontFace()) {
        return;
    }

    // 获取字体目录路径
    const fontDir = await paths.getAppDirectoryPath('ASSETS_FONT');

    // 构建字体文件的完整路径
    const fontPath = `${fontDir}\\${FONT_FILENAME}`;

    // 转换为前端可用的 URL
    const fontUrl = refresh
        ? appendFontReloadToken(convertFileSrc(fontPath), ++fontReloadToken)
        : convertFileSrc(fontPath);

    // 动态注入 @font-face 规则
    if (!refresh && hasInjectedFontFace()) {
        return;
    }

    const style = document.createElement('style');
    style.setAttribute(FONT_FACE_STYLE_ATTRIBUTE, FONT_FACE_STYLE_KEY);
    style.textContent = `
        @font-face {
            font-family: '${FONT_FACE_FAMILY}';
            src: url('${fontUrl}') format('woff2');
            font-weight: 250 900;
            font-style: normal;
            font-display: swap;
        }
    `;
    getInjectedFontFaceStyle()?.remove();
    document.head.appendChild(style);

    console.log('Source Han Serif font loaded successfully from:', fontUrl);
}

function loadFontFace(options: LoadFontFaceOptions = {}): Promise<void> {
    const { refresh = false } = options;

    if (!refresh && hasInjectedFontFace()) {
        return Promise.resolve();
    }

    if (!refresh && fontLoadPromise) {
        return fontLoadPromise;
    }

    const loadPromise = injectFontFace(options).finally(() => {
        fontLoadPromise = null;
    });

    if (refresh) {
        return loadPromise;
    }

    fontLoadPromise = loadPromise;
    return fontLoadPromise;
}

function logFontLoadError(error: unknown): void {
    console.error('Failed to load Source Han Serif font:', error);
    // 字体加载失败不应阻止应用运行，只记录错误
}

function ensureFontReadyListener(): Promise<void> {
    if (fontReadyListenerPromise) {
        return fontReadyListenerPromise;
    }

    fontReadyListenerPromise = eventService
        .on(AppEvent.FONT_READY, () => {
            void loadFontFace({ refresh: true }).catch(logFontLoadError);
        })
        .then(() => undefined)
        .catch((error) => {
            fontReadyListenerPromise = null;
            console.error('Failed to listen for font-ready event:', error);
        });

    return fontReadyListenerPromise;
}

/**
 * 初始化字体加载监听器
 *
 * 主动尝试加载字体，并监听 Rust 后端发送的 `font:ready` 事件作为下载完成后的补充通知。
 */
export function initializeFontLoader(): void {
    ensureFontReadyListener().finally(() => {
        void loadFontFace().catch(logFontLoadError);
    });
}
