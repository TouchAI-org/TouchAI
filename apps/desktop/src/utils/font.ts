// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { AppEvent, eventService } from '@services/EventService';
import { paths } from '@services/NativeService';
import { log } from '@services/ObservabilityService';
import { convertFileSrc } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { exists, readFile } from '@tauri-apps/plugin-fs';

const FONT_FILENAME = 'SourceHanSerifSC-VF.ttf.woff2';
const FONT_FACE_FAMILY = 'TouchAI Source Han Serif SC';
const FONT_FACE_STYLE_ATTRIBUTE = 'data-touchai-font-face';
const FONT_FACE_STYLE_KEY = 'source-han-serif-sc';
const FONT_LOAD_TEST = `16px '${FONT_FACE_FAMILY}'`;
const FONT_LOAD_ATTEMPTS = 3;
const FONT_LOAD_RETRY_DELAY_MS = 16;
const FONT_WEIGHT_RANGE = '250 900';

let fontLoadPromise: Promise<void> | null = null;
let fontReadyListenerPromise: Promise<void> | null = null;
let fontReloadToken = 0;
let fontInjectionToken = 0;
let registeredFontFace: FontFace | null = null;
let fontRegisteredFromBytes = false;

interface LoadFontFaceOptions {
    refresh?: boolean;
    requireExistingFile?: boolean;
}

interface FontLoadDiagnostics {
    fontUrl: string;
    fontLoaded: boolean;
    fontsApiAvailable: boolean;
    fontsLoadError?: string;
    fetchOk?: boolean;
    fetchStatus?: number;
    fetchStatusText?: string;
    fetchContentLength?: string | null;
    fetchError?: string;
    userAgent: string;
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

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

function hasUsableFontFace(): boolean {
    return hasInjectedFontFace() || fontRegisteredFromBytes;
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

async function verifyInjectedFontFace(fontUrl: string): Promise<boolean> {
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

                let loadRejected = false;

                try {
                    await document.fonts.load(FONT_LOAD_TEST);
                } catch (error) {
                    diagnostics.fontsLoadError = stringifyError(error);
                    loadRejected = true;
                }

                if (loadRejected) {
                    diagnostics.fontLoaded = false;
                    break;
                }

                diagnostics.fontLoaded = document.fonts.check(FONT_LOAD_TEST);

                if (diagnostics.fontLoaded) {
                    break;
                }
            }
        }
    } catch (error) {
        diagnostics.fontsLoadError = stringifyError(error);
    }

    if (!diagnostics.fontLoaded && typeof fetch === 'function') {
        try {
            const response = await fetch(fontUrl);
            diagnostics.fetchOk = response.ok;
            diagnostics.fetchStatus = response.status;
            diagnostics.fetchStatusText = response.statusText;
            diagnostics.fetchContentLength = response.headers.get('content-length');
        } catch (error) {
            diagnostics.fetchError = stringifyError(error);
        }
    }

    if (diagnostics.fontLoaded && diagnostics.fetchOk !== false) {
        log.info('Source Han Serif font ready:', diagnostics);
    } else {
        log.warn('Source Han Serif font diagnostics:', diagnostics);
    }

    return !diagnostics.fontsApiAvailable || diagnostics.fontLoaded;
}

function removeRegisteredFontFace(): void {
    if (!registeredFontFace) {
        fontRegisteredFromBytes = false;
        return;
    }

    document.fonts.delete(registeredFontFace);
    registeredFontFace = null;
    fontRegisteredFromBytes = false;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    if (
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength &&
        bytes.buffer instanceof ArrayBuffer
    ) {
        return bytes.buffer;
    }

    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readFontSignature(bytes: Uint8Array): string {
    return String.fromCharCode(...bytes.subarray(0, 4));
}

async function registerFontFaceFromFile(
    fontPath: string,
    injectionToken: number
): Promise<boolean> {
    if (
        typeof FontFace !== 'function' ||
        typeof document.fonts?.add !== 'function' ||
        typeof document.fonts?.delete !== 'function'
    ) {
        log.warn('Source Han Serif font file fallback is unavailable');
        return false;
    }

    let bytes: Uint8Array;

    try {
        bytes = await readFile(fontPath);
    } catch (error) {
        log.warn('Source Han Serif font file fallback failed at readFile:', {
            errorName: errorName(error),
            error: stringifyError(error),
            userAgent: navigator.userAgent,
        });
        return false;
    }

    if (injectionToken !== fontInjectionToken) {
        return false;
    }

    const byteLength = bytes.byteLength;
    log.info('Source Han Serif font bytes read:', {
        byteLength,
        signature: readFontSignature(bytes),
        userAgent: navigator.userAgent,
    });

    const descriptors: FontFaceDescriptors = {
        weight: FONT_WEIGHT_RANGE,
        style: 'normal',
        display: 'swap',
    };
    const fontBuffer = toArrayBuffer(bytes);
    const candidates: Array<{
        label: string;
        source: BufferSource;
        descriptors: FontFaceDescriptors;
    }> = [
        {
            label: 'arraybuffer-range',
            source: fontBuffer,
            descriptors,
        },
        {
            label: 'uint8-range',
            source: new Uint8Array(fontBuffer) as BufferSource,
            descriptors,
        },
    ];

    for (const candidate of candidates) {
        try {
            const fontFace = new FontFace(
                FONT_FACE_FAMILY,
                candidate.source,
                candidate.descriptors
            );
            await fontFace.load();

            if (injectionToken !== fontInjectionToken) {
                return false;
            }

            removeRegisteredFontFace();
            document.fonts.add(fontFace);
            registeredFontFace = fontFace;
            fontRegisteredFromBytes = true;
            log.info('Source Han Serif font registered from file:', {
                variant: candidate.label,
                byteLength,
                userAgent: navigator.userAgent,
            });
            return true;
        } catch (error) {
            log.warn('Source Han Serif font file candidate failed:', {
                variant: candidate.label,
                errorName: errorName(error),
                error: stringifyError(error),
                userAgent: navigator.userAgent,
            });
        }
    }

    log.warn('Source Han Serif font file fallback failed:', {
        byteLength,
        userAgent: navigator.userAgent,
    });
    return false;
}

async function injectFontFace(
    options: LoadFontFaceOptions = {},
    recoverRemovedStyle = true
): Promise<boolean> {
    const { refresh = false, requireExistingFile = false } = options;

    if (!refresh && hasUsableFontFace()) {
        return true;
    }

    const fontPath = await resolveFontPath();
    if (requireExistingFile && !(await exists(fontPath))) {
        return false;
    }

    const fontUrl = refresh
        ? appendFontReloadToken(convertFileSrc(fontPath), ++fontReloadToken)
        : convertFileSrc(fontPath);

    if (!refresh && hasUsableFontFace()) {
        return true;
    }

    const style = document.createElement('style');
    style.setAttribute(FONT_FACE_STYLE_ATTRIBUTE, FONT_FACE_STYLE_KEY);
    /*
     * `format('woff2')` is the container hint every supported engine parses. The
     * legacy `woff2-variations` alias is rejected by WebKitGTK 2.52 in release
     * builds: the whole `src` entry is dropped and the face ends in `status:
     * "error"`, even though the bytes are a valid variable WOFF2. Variation
     * capability comes from `font-weight: 250 900` below, not from the format
     * hint, so the standard WOFF2 container value keeps the axis intact.
     */
    style.textContent = `
        @font-face {
            font-family: '${FONT_FACE_FAMILY}';
            src: url('${fontUrl}') format('woff2');
            font-weight: ${FONT_WEIGHT_RANGE};
            font-style: normal;
            font-display: swap;
        }
    `;
    getInjectedFontFaceStyle()?.remove();
    document.head.appendChild(style);
    fontRegisteredFromBytes = false;

    const injectionToken = ++fontInjectionToken;
    const fontLoaded = await verifyInjectedFontFace(fontUrl);

    if (recoverRemovedStyle && !hasInjectedFontFace()) {
        return injectFontFace(options, false);
    }

    if (injectionToken !== fontInjectionToken || !hasInjectedFontFace()) {
        return true;
    }

    if (fontLoaded) {
        removeRegisteredFontFace();
    } else {
        // A failed face with the same family must leave the font set before the
        // bytes fallback registers its replacement, or WebKit keeps resolving
        // the poisoned family to the failed face.
        getInjectedFontFaceStyle()?.remove();
        await waitForStyleProcessing();

        if (injectionToken !== fontInjectionToken) {
            return true;
        }

        await registerFontFaceFromFile(fontPath, injectionToken);
    }

    return true;
}

function loadFontFace(options: LoadFontFaceOptions = {}): Promise<void> {
    const { refresh = false } = options;

    if (!refresh && hasUsableFontFace()) {
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
    log.error('Failed to load Source Han Serif font:', error);
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
            log.error('Failed to listen for font-ready event:', error);
        });

    return fontReadyListenerPromise;
}

export function initializeFontLoader(): void {
    ensureFontReadyListener().finally(() => {
        void loadFontFace({ requireExistingFile: true }).catch(logFontLoadError);
    });
}
