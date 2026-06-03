// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { AppEvent, eventService } from '@services/EventService';
import { paths } from '@services/NativeService';
import { convertFileSrc } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';

const FONT_FILENAME = 'SourceHanSerifSC-VF.ttf.woff2';
const FONT_FACE_FAMILY = 'TouchAI Source Han Serif SC';
const FONT_FACE_STYLE_ATTRIBUTE = 'data-touchai-font-face';
const FONT_FACE_STYLE_KEY = 'source-han-serif-sc';

let fontLoadPromise: Promise<void> | null = null;
let fontReadyListenerPromise: Promise<void> | null = null;
let fontReloadToken = 0;

interface LoadFontFaceOptions {
    refresh?: boolean;
    requireExistingFile?: boolean;
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

async function resolveFontPath(): Promise<string> {
    const fontDir = await paths.getAppDirectoryPath('ASSETS_FONT');
    return join(fontDir, FONT_FILENAME);
}

async function injectFontFace(options: LoadFontFaceOptions = {}): Promise<boolean> {
    const { refresh = false, requireExistingFile = false } = options;

    if (!refresh && hasInjectedFontFace()) {
        return true;
    }

    const fontPath = await resolveFontPath();
    if (requireExistingFile && !(await exists(fontPath))) {
        return false;
    }

    const fontUrl = refresh
        ? appendFontReloadToken(convertFileSrc(fontPath), ++fontReloadToken)
        : convertFileSrc(fontPath);

    if (!refresh && hasInjectedFontFace()) {
        return true;
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
    return true;
}

function loadFontFace(options: LoadFontFaceOptions = {}): Promise<void> {
    const { refresh = false } = options;

    if (!refresh && hasInjectedFontFace()) {
        return Promise.resolve();
    }

    if (!refresh && fontLoadPromise) {
        return fontLoadPromise;
    }

    const loadPromise = injectFontFace(options)
        .then(() => undefined)
        .finally(() => {
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

export function initializeFontLoader(): void {
    ensureFontReadyListener().finally(() => {
        void loadFontFace({ requireExistingFile: true }).catch(logFontLoadError);
    });
}
