/**
 * Shared WebDriver helpers for the desktop E2E specs.
 *
 * The specs describe user-visible flows: what a person sees and does after
 * launching TouchAI. They never reach into Vue internals; every hook below is
 * either a real DOM interaction or the app's own E2E bridge.
 *
 * Assertions throw with an explicit message instead of relying on a test
 * framework matcher, so a failing spec names the user-visible expectation that
 * broke.
 */

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * The settings window size the app opens with.
 *
 * Mirrors `SETTINGS_WINDOW_WIDTH`/`SETTINGS_WINDOW_HEIGHT` in
 * `src-tauri/src/core/window/settings/mod.rs`. Visual baselines use it so they
 * capture the layout a user actually gets, not a convenient test viewport; the
 * Rust file asserts those constants stay in a sane range, and
 * `tests/ci/e2e-visual-coverage.test.ts` asserts this copy matches them.
 */
export const SETTINGS_WINDOW_DEFAULT_SIZE = [1120, 700];

export function assertVisible(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

export async function waitForE2eBridge(timeoutMs = DEFAULT_TIMEOUT_MS) {
    await browser.waitUntil(async () => browser.execute(() => Boolean(window.__TOUCHAI_E2E__)), {
        timeout: timeoutMs,
        timeoutMsg: 'TouchAI E2E bridge did not become available in the renderer.',
    });
}

export async function callE2eBridge(methodName, ...args) {
    const result = await browser.executeAsync(
        (name, bridgeArgs, done) => {
            const bridge = window.__TOUCHAI_E2E__;
            if (!bridge || typeof bridge[name] !== 'function') {
                done({ ok: false, error: `E2E bridge method "${name}" is not available.` });
                return;
            }

            Promise.resolve(bridge[name](...bridgeArgs))
                .then(() => done({ ok: true }))
                .catch((error) => done({ ok: false, error: String(error) }));
        },
        methodName,
        args
    );

    if (!result?.ok) {
        throw new Error(
            `E2E bridge call "${methodName}" failed: ${result?.error ?? 'unknown error'}`
        );
    }
}

export async function findElementByTestId(testId) {
    return $(`[data-testid='${testId}']`);
}

/**
 * The interface language every E2E run uses.
 *
 * First-launch language is derived from `navigator.language`, so the same screen
 * renders Chinese on a zh-CN laptop and English on an en-US CI runner. Visual
 * baselines are compared pixel by pixel and must not encode the machine, so the
 * suite pins the app's own language setting instead. `en-US` is the fallback
 * first-launch locale and its Latin glyphs rasterise the same everywhere, which
 * keeps the baselines stable; the Chinese interface is still covered by the i18n
 * tests.
 */
export const E2E_INTERFACE_LANGUAGE = 'en-US';

/**
 * Pins the interface language through the app's settings store, the same path a
 * user takes. Text stays visible in the screenshots, which is the point: a
 * baseline with transparent glyphs shows layout but not the interface a reviewer
 * is being asked to approve.
 */
export async function useInterfaceLanguage(locale = E2E_INTERFACE_LANGUAGE) {
    await callE2eBridge('setLanguage', locale);
}

/**
 * Mismatch budget for a visual comparison, in percent.
 *
 * Baselines are rendered at 1x by the CI runner, which is the environment that
 * gates a PR, so that is where the strict 2% applies. A scaled display (125% or
 * 150%) captures more pixels and the comparison resamples them back down; that
 * alone costs a couple of percent on text-heavy screens, so a local run gets a
 * wider budget instead of failing on its own DPI. Returning the same 2% there
 * would make the suite unusable on a laptop; returning a wide budget everywhere
 * would weaken the gate.
 */
export async function visualMismatchTolerance() {
    const devicePixelRatio = await browser.execute(() => window.devicePixelRatio);
    return devicePixelRatio === 1 ? 2 : 5;
}

/**
 * Makes the app render the product serif face, or fails if that is impossible.
 *
 * Two things have to be true for a baseline to depict what a user sees:
 *
 * 1. The font file must exist. The app ships none: it downloads Source Han Serif
 *    into `<app root>/assets/font/` on first launch, so `wdio.conf.js` provisions
 *    it for each session.
 * 2. The browser must be allowed to load it. `src/utils/font.ts` points
 *    `@font-face` at the asset protocol, which on Windows is
 *    `http://asset.localhost`; the shipped CSP lists only `'self' data: asset:`
 *    for `font-src`, so that request is blocked and every serif element falls back
 *    to a generic face. `connect-src` does allow `http:`, so the bytes are
 *    readable, and `font-src` does allow `data:`.
 *
 * This therefore rewrites the already-injected rule to a `data:` source, inside
 * the page. The element and its marker attribute stay in place because `font.ts`
 * looks for them when another window starts, and each window has its own renderer
 * so each calls this once.
 *
 * Without it the screenshots stay internally consistent but show Times New Roman
 * where the interface asks for Source Han Serif — exactly the kind of quiet
 * infidelity a visual gate must not have.
 */
export async function useProductFont() {
    const result = await browser.executeAsync((done) => {
        const family = 'TouchAI Source Han Serif SC';
        const style = document.querySelector('style[data-touchai-font-face]');

        if (!style) {
            done({ ok: false, error: 'the app did not inject its @font-face rule' });
            return;
        }

        if (style.getAttribute('data-touchai-e2e-font') === '1') {
            done({ ok: true, bytes: Number(style.getAttribute('data-bytes') ?? 0) });
            return;
        }

        const fontUrl = style.textContent?.match(/url\('([^']+)'\)/)?.[1];
        if (!fontUrl) {
            done({ ok: false, error: 'the injected @font-face rule has no URL' });
            return;
        }

        (async () => {
            const response = await fetch(fontUrl);
            if (!response.ok) {
                throw new Error(`the font file request returned HTTP ${response.status}`);
            }

            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = '';
            const chunkSize = 0x8000;
            for (let index = 0; index < bytes.length; index += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
            }

            style.textContent = `
                @font-face {
                    font-family: '${family}';
                    src: url('data:font/woff2;base64,${btoa(binary)}') format('woff2');
                    font-weight: 250 900;
                    font-style: normal;
                    font-display: block;
                }
            `;
            style.setAttribute('data-touchai-e2e-font', '1');
            style.setAttribute('data-bytes', String(bytes.length));

            await document.fonts.load(`16px '${family}'`);

            if (!document.fonts.check(`16px '${family}'`)) {
                throw new Error('the font was registered but does not resolve');
            }

            return bytes.length;
        })()
            .then((bytes) => done({ ok: true, bytes }))
            .catch((error) => done({ ok: false, error: String(error) }));
    });

    if (!result?.ok) {
        throw new Error(
            `The product serif font could not be loaded (${result?.error ?? 'unknown error'}), so screenshots would show a fallback face instead of the interface a user sees.`
        );
    }
}

export async function waitForTestIdDisplayed(testId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const element = await findElementByTestId(testId);
    await element.waitForDisplayed({ timeout: timeoutMs });
    return element;
}

export async function waitForTestIdNotDisplayed(testId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const element = await findElementByTestId(testId);
    await element.waitForDisplayed({ timeout: timeoutMs, reverse: true });
    return element;
}

/**
 * Switch to the window whose URL contains `urlFragment` and return its handle.
 * Restores the original window when no match appears so a failing spec leaves a
 * valid window context behind.
 */
export async function switchToWindowContaining(urlFragment, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const originalHandle = await browser.getWindowHandle();
    let matchedHandle = null;

    try {
        await browser.waitUntil(
            async () => {
                const handles = await browser.getWindowHandles();

                for (const handle of handles) {
                    if (handle === originalHandle) {
                        continue;
                    }

                    await browser.switchToWindow(handle);
                    const currentUrl = await browser.getUrl();

                    if (currentUrl.includes(urlFragment)) {
                        matchedHandle = handle;
                        return true;
                    }
                }

                await browser.switchToWindow(originalHandle);
                return false;
            },
            {
                timeout: timeoutMs,
                timeoutMsg: `No window whose URL contains "${urlFragment}" appeared.`,
            }
        );
    } catch (error) {
        await browser.switchToWindow(originalHandle);
        throw error;
    }

    return matchedHandle;
}

export async function getAriaChecked(element) {
    return element.getAttribute('aria-checked');
}

/**
 * Toggle a switch-like control and wait until the platform reports the new
 * state, so assertions never race the animation.
 */
export async function toggleSwitch(element, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const before = await getAriaChecked(element);

    await element.click();
    await browser.waitUntil(async () => (await getAriaChecked(element)) !== before, {
        timeout: timeoutMs,
        timeoutMsg: `Switch did not change from aria-checked="${before}" after a click.`,
    });

    return before;
}
