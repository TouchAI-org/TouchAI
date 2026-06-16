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
const FONT_LOAD_TEST = `16px '${FONT_FACE_FAMILY}'`;
const FONT_LOAD_ATTEMPTS = 3;
const FONT_LOAD_RETRY_DELAY_MS = 16;

let fontLoadPromise: Promise<void> | null = null;
let fontReadyListenerPromise: Promise<void> | null = null;
let fontReloadToken = 0;

interface LoadFontFaceOptions {
    refresh?: boolean;
    requireExistingFile?: boolean;
}

interface FontLoadDiagnostics {
    fontUrl: string;
    fontLoaded: boolean;
    fontsApiAvailable: boolean;
    fetchOk?: boolean;
    fetchStatus?: number;
    fetchStatusText?: string;
    contentType?: string | null;
    userAgent: string;
    error?: string;
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

function stringifyError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

async function waitForStyleProcessing(): Promise<void> {
    await Promise.resolve();

    await new Promise<void>((resolve) => {
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => resolve());
            return;
        }

        window.setTimeout(resolve, 0);
    });
}

async function resolveFontPath(): Promise<string> {
    const fontDir = await paths.getAppDirectoryPath('ASSETS_FONT');
    return join(fontDir, FONT_FILENAME);
}

async function verifyInjectedFontFace(fontUrl: string): Promise<void> {
    const diagnostics: FontLoadDiagnostics = {
        fontUrl,
        fontLoaded: false,
        fontsApiAvailable:
            typeof document.fonts?.load === 'function' &&
            typeof document.fonts?.check === 'function',
        userAgent: navigator.userAgent,
    };

    try {
        if (diagnostics.fontsApiAvailable) {
            await waitForStyleProcessing();

            for (let attempt = 0; attempt < FONT_LOAD_ATTEMPTS; attempt += 1) {
                if (attempt > 0) {
                    await delay(FONT_LOAD_RETRY_DELAY_MS);
                }

                await document.fonts.load(FONT_LOAD_TEST);
                diagnostics.fontLoaded = document.fonts.check(FONT_LOAD_TEST);

                if (diagnostics.fontLoaded) {
                    break;
                }
            }
        }

        if (typeof fetch === 'function') {
            const response = await fetch(fontUrl);
            diagnostics.fetchOk = response.ok;
            diagnostics.fetchStatus = response.status;
            diagnostics.fetchStatusText = response.statusText;
            diagnostics.contentType = response.headers.get('content-type');
        }
    } catch (error) {
        diagnostics.error = stringifyError(error);
    }

    if (diagnostics.fontLoaded && diagnostics.fetchOk !== false) {
        console.info('Source Han Serif font ready:', diagnostics);
    } else {
        console.warn('Source Han Serif font diagnostics:', diagnostics);
    }
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

    await verifyInjectedFontFace(fontUrl);
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
