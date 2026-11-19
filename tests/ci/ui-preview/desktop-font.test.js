// @vitest-environment jsdom

import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProductFont } from '../../../apps/desktop/e2e-tests/test/support/desktop.js';

const desktopRequire = createRequire(
    createRequire(import.meta.url).resolve('../../../apps/desktop/package.json')
);
const { generate, parse } = createRequire(desktopRequire.resolve('jsdom'))('css-tree');
const PRODUCT_FAMILY = 'TouchAI Source Han Serif SC';
const WOFF2_URL = 'asset://localhost/fonts/SourceHanSerifSC-VF.ttf.woff2?touchaiFontReload=7';
const TTF_URL = 'asset://localhost/fonts/SourceHanSerifSC-VF.ttf';

function installFontBrowser({ differentOutlines = false, rejectReference = false } = {}) {
    const faces = new Set();
    const sources = new Set();
    const pendingLoads = [];
    let productStyle;
    let productFace;

    // jsdom drops font-face descriptors such as src; its CSS parser preserves them.
    vi.spyOn(HTMLStyleElement.prototype, 'sheet', 'get').mockImplementation(function () {
        return {
            cssRules: [...parse(this.textContent).children]
                .filter((rule) => rule.type === 'Atrule' && rule.name === 'font-face')
                .map((rule) => {
                    const declarations = new Map(
                        [...rule.block.children].map(({ property, value }) => [
                            property,
                            generate(value),
                        ])
                    );
                    return {
                        type: CSSRule.FONT_FACE_RULE,
                        style: { getPropertyValue: (name) => declarations.get(name) ?? '' },
                    };
                }),
        };
    });
    const fontRules = () =>
        [...document.querySelectorAll('style')].flatMap((style) =>
            [...style.sheet.cssRules].filter((rule) => rule.type === CSSRule.FONT_FACE_RULE)
        );

    const fonts = {
        ready: Promise.resolve(),
        check: () => true,
        [Symbol.iterator]: () => faces.values(),
        async load(probe) {
            const family = probe.match(/'([^']+)'/)[1];
            if (family === PRODUCT_FAMILY) {
                if (!productFace) return [];
                if (productFace.status === 'error') throw new Error('WOFF2 load failed');
                if (productFace.status === 'loaded') return [productFace];
                return new Promise((resolve, reject) => pendingLoads.push({ resolve, reject }));
            }

            const rule = fontRules().find(
                (entry) =>
                    entry.style.getPropertyValue('font-family').replace(/['"]/g, '') === family
            );
            if (!rule) return [];

            const source = rule.style.getPropertyValue('src');
            if (!sources.has(source)) {
                throw new Error(`Reference font has an incorrect URL or format: ${source}`);
            }
            const face = { family, status: rejectReference ? 'error' : 'loaded' };
            faces.add(face);
            if (rejectReference) throw new Error('Reference font load failed');
            return [face];
        },
    };
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
        const context = {
            fillRect() {},
            fillText() {},
            getImageData: () => ({
                data: new Uint8ClampedArray(600 * 4).fill(
                    differentOutlines && context.font.includes(PRODUCT_FAMILY) ? 255 : 0
                ),
            }),
        };
        return context;
    });
    vi.stubGlobal('browser', {
        execute: async (script, ...args) => script(...args),
        async waitUntil(condition, { timeout, timeoutMsg }) {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeout) {
                if (await condition()) return true;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error(timeoutMsg);
        },
    });

    function setStatus(status) {
        productFace.status = status;
        if (status === 'loaded' || status === 'error') {
            for (const pending of pendingLoads.splice(0)) {
                if (status === 'loaded') pending.resolve([productFace]);
                else pending.reject(new Error('WOFF2 load failed'));
            }
        }
    }

    function removeProduct() {
        productStyle?.remove();
        faces.delete(productFace);
        productStyle = undefined;
        productFace = undefined;
    }

    function injectProduct({
        url = WOFF2_URL,
        format = 'woff2',
        status = 'loaded',
        quote = "'",
    } = {}) {
        removeProduct();
        productStyle = document.createElement('style');
        productStyle.setAttribute('data-touchai-font-face', 'source-han-serif-sc');
        productStyle.textContent = `
            @font-face {
                font-family: '${PRODUCT_FAMILY}';
                src: url(${quote}${url}${quote}) format(${quote}${format}${quote});
                font-weight: 250 900;
                font-style: normal;
                font-display: swap;
            }
        `;
        document.head.appendChild(productStyle);
        sources.add(productStyle.sheet.cssRules[0].style.getPropertyValue('src'));
        productFace = { family: PRODUCT_FAMILY, status };
        faces.add(productFace);
    }

    return { injectProduct, removeProduct, setStatus };
}

function startFontCheck() {
    const outcome = { status: 'pending' };
    void useProductFont().then(
        () => {
            outcome.status = 'passed';
        },
        (error) => {
            outcome.status = 'failed';
            outcome.error = error.message;
        }
    );
    return outcome;
}

describe('user validates desktop evidence while the product font loads', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.head.innerHTML = '';
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        delete document.fonts;
        document.head.innerHTML = '';
    });

    it.each([
        { format: 'woff2', url: WOFF2_URL, quote: "'" },
        { format: 'truetype', url: TTF_URL, quote: '"' },
    ])('user gets passing evidence with the declared $format source', async (source) => {
        const font = installFontBrowser();
        font.injectProduct(source);

        const outcome = startFontCheck();
        await vi.runAllTimersAsync();

        expect(outcome).toEqual({ status: 'passed' });
    });

    it('user waits for a late product face to load even when the font set already reports ready', async () => {
        const font = installFontBrowser();
        const outcome = startFontCheck();

        await vi.advanceTimersByTimeAsync(1000);
        expect(outcome).toEqual({ status: 'pending' });

        font.injectProduct({ status: 'loading' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(outcome).toEqual({ status: 'pending' });

        font.setStatus('loaded');
        await vi.runAllTimersAsync();
        expect(outcome).toEqual({ status: 'passed' });
    });

    it('user gets passing evidence when WOFF2 fails and the replacement TTF loads after fifteen seconds', async () => {
        const font = installFontBrowser();
        font.injectProduct({ status: 'unloaded' });
        const outcome = startFontCheck();

        await vi.advanceTimersByTimeAsync(1000);
        expect(outcome).toEqual({ status: 'pending' });
        font.setStatus('error');
        await vi.advanceTimersByTimeAsync(4000);
        expect(outcome).toEqual({ status: 'pending' });

        font.removeProduct();
        await vi.advanceTimersByTimeAsync(10000);
        expect(outcome).toEqual({ status: 'pending' });
        font.injectProduct({ url: TTF_URL, format: 'truetype', status: 'loading' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(outcome).toEqual({ status: 'pending' });

        font.setStatus('loaded');
        await vi.runAllTimersAsync();
        expect(outcome).toEqual({ status: 'passed' });
    });

    it.each(['absent', 'unloaded', 'loading', 'error'])(
        'user gets a bounded failure when the product face stays %s despite a successful availability check',
        async (status) => {
            const font = installFontBrowser();
            if (status !== 'absent') font.injectProduct({ status });

            const outcome = startFontCheck();
            await vi.advanceTimersByTimeAsync(60000);

            expect(outcome.status).toBe('failed');
            expect(outcome.error).toMatch(/product font.*loaded/i);
        }
    );

    it('user gets a failure when the loaded product paints different outlines from the reference', async () => {
        const font = installFontBrowser({ differentOutlines: true });
        font.injectProduct();

        const outcome = startFontCheck();
        await vi.runAllTimersAsync();

        expect(outcome.error).toContain('painting a fallback face');
    });

    it('user gets a failure when the reference font cannot load', async () => {
        const font = installFontBrowser({ rejectReference: true });
        font.injectProduct();

        const outcome = startFontCheck();
        await vi.runAllTimersAsync();

        expect(outcome.error).toBe('Reference font load failed');
    });

    it('user gets a failure when test font bytes replace the asset protocol source', async () => {
        const font = installFontBrowser();
        font.injectProduct({ url: 'data:font/woff2;base64,AAAA' });

        const outcome = startFontCheck();
        await vi.runAllTimersAsync();

        expect(outcome.error).toContain('asset-protocol loading path was not exercised');
    });
});
