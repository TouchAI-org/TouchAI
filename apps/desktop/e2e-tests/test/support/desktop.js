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
    // WebdriverIO 10 removed executeAsync; execute now awaits async scripts.
    const result = await browser.execute(
        async (name, bridgeArgs) => {
            const bridge = window.__TOUCHAI_E2E__;
            if (!bridge || typeof bridge[name] !== 'function') {
                return { ok: false, error: `E2E bridge method "${name}" is not available.` };
            }

            try {
                await bridge[name](...bridgeArgs);
                return { ok: true };
            } catch (error) {
                return { ok: false, error: String(error) };
            }
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
 * Fails unless the interface is really painted in the product typeface.
 *
 * A font failure is silent, so this needs to be exact. Every cheaper version of it gave
 * a false pass, each measured in the app:
 *
 *   - `document.fonts.check("16px 'TouchAI Source Han Serif SC'")` returns `true` even
 *     for a family that exists nowhere:
 *     `document.fonts.check("16px 'NoSuchFamilyXYZ123'")` -> `true`.
 *   - `FontFace.status` reaches `"loaded"` whenever the bytes download and parse, even
 *     when the engine then declines to paint them.
 *   - Comparing against generic `serif` fails both ways. On a developer machine it
 *     resolves to an installed CJK serif — on this project's machines, Noto Serif SC,
 *     the same design as the shipped font, so the two are a few pixels apart. On a bare
 *     CI runner it resolves to Times New Roman, which has no Han glyphs, so both sides
 *     rasterise identical tofu. Either way a double fallback reads as a match.
 *   - Comparing ink counts: the same count meant "real font" on one engine build and
 *     "fallback" on another.
 *   - Comparing advance widths across weights: browsers apply synthetic bold to any
 *     family, so a fallback also widens from 250 to 700 and mimics an interpolating axis.
 *   - `new FontFace(bytes, { weight: '250 900' })` as the reference: that constructor
 *     form falls back in this engine exactly like a bad CSS rule, making the reference
 *     the broken side of the comparison.
 *
 * What works is two steps, and the first is what makes the second trustworthy:
 *
 *   1. The engine must have registered a `FontFace` for the reference family. When it
 *      rejects the format hint it registers none — measured on WebView2 155 with
 *      `format('woff2 supports variations')`: zero entries. That is structural and does
 *      not depend on which fonts the machine has installed.
 *   2. The painted Han outline must match a reference face built from the app's own
 *      bytes. Outlines cannot be faked by synthetic bold the way widths can, and both
 *      sides derive from the same file, so no installed font participates.
 *
 * Without step 1 a rejected rule makes the reference fall back too, the two sides agree,
 * and the check passes on a window showing the wrong typeface — which is exactly how a
 * wrong baseline shipped once.
 */
export async function useProductFont() {
    const family = 'TouchAI Source Han Serif SC';
    const referenceFamily = 'TouchAI E2E Reference';

    const report = await browser.executeAsync(
        (productFamily, refFamily, done) => {
            (async () => {
                await document.fonts.load(`52px '${productFamily}'`);
                await document.fonts.ready;

                const injected = document.querySelector(
                    'style[data-touchai-font-face]'
                )?.textContent;
                const fontUrl = injected?.match(/url\('([^']+)'\)/)?.[1];

                function rasterise(target) {
                    const canvas = document.createElement('canvas');
                    canvas.width = 460;
                    canvas.height = 110;
                    const context = canvas.getContext('2d');
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    context.fillStyle = '#000000';
                    context.font = `52px ${target}`;
                    context.textBaseline = 'top';
                    context.fillText('通用启动', 6, 10);
                    return context.getImageData(0, 0, canvas.width, canvas.height).data;
                }

                function differingPixels(first, second) {
                    let changed = 0;
                    for (let index = 0; index < first.length; index += 4) {
                        if (first[index] !== second[index]) {
                            changed += 1;
                        }
                    }
                    return changed;
                }

                // The reference declares the same format hint the product uses. If the
                // engine rejects it, no face appears and step 1 below fails loudly
                // instead of the comparison silently agreeing with itself.
                const referenceRule = document.createElement('style');
                referenceRule.textContent = `
                    @font-face {
                        font-family: '${refFamily}';
                        src: url('${fontUrl}') format('woff2-variations');
                        font-weight: 250 900;
                        font-style: normal;
                        font-display: block;
                    }
                `;
                document.head.appendChild(referenceRule);
                await document.fonts.load(`52px '${refFamily}'`);
                await document.fonts.ready;
                // Rasterising before the face settles silently measures the fallback.
                await new Promise((resolve) => setTimeout(resolve, 300));

                const referenceFaces = [...document.fonts].filter(
                    (face) => face.family === refFamily
                );
                const productFaces = [...document.fonts].filter(
                    (face) => face.family === productFamily
                );

                const product = rasterise(`'${productFamily}'`);
                const reference = rasterise(`'${refFamily}'`);

                return {
                    usesDataUrl: (injected ?? '').includes('data:font'),
                    againstReference: differingPixels(product, reference),
                    referenceFaceCount: referenceFaces.length,
                    referenceFaceStatus: referenceFaces.map((face) => face.status),
                    productFaceCount: productFaces.length,
                    declaredFormat: injected?.match(/format\('([^']+)'\)/)?.[1] ?? 'none',
                    declaredWeight:
                        injected?.match(/font-weight:\s*([^;]+);/)?.[1]?.trim() ?? 'none',
                };
            })()
                .then((result) => done(result))
                .catch((error) => done({ error: String(error) }));
        },
        family,
        referenceFamily
    );

    if (report?.error) {
        throw new Error(`The product font could not be measured: ${report.error}`);
    }

    if (report.usesDataUrl) {
        throw new Error(
            "A data: font source was injected by the test, so the app's own asset-protocol loading path was not exercised."
        );
    }

    const detail =
        `declared format: ${report.declaredFormat}, ` +
        `declared weight: ${report.declaredWeight}, ` +
        `reference faces: ${report.referenceFaceCount} ` +
        `${JSON.stringify(report.referenceFaceStatus)}`;

    // Step 1: the engine must have registered a face for the family. A rejected format
    // hint registers none, and then the pixel comparison below would compare two
    // fallbacks and pass. This is the structural signal that makes step 2 trustworthy.
    if (report.referenceFaceCount === 0) {
        throw new Error(
            `The engine rejected the @font-face rule outright, so the font cannot be ` +
                `painted (${detail}). Check the format() hint against CSS Fonts 4.`
        );
    }

    if (report.productFaceCount === 0) {
        throw new Error(`The app's own @font-face rule was rejected by the engine (${detail}).`);
    }

    // Step 2: the painted outline must match the shipped bytes. Anti-aliasing leaves a
    // handful of differing pixels; a fallback differs by thousands.
    if (report.againstReference > 500) {
        throw new Error(
            `The interface is painting a fallback face instead of "${family}" ` +
                `(${report.againstReference} pixels differ from the shipped file). ${detail}. ` +
                'Screenshots would depict a typeface no user sees.'
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

/**
 * Switch back to the search window and keep re-asserting the switch until its
 * E2E bridge answers. WebdriverIO 10 selects the first remaining handle in the
 * background after closeWindow(); that selection can land after an explicit
 * switch and leave the driver on a blank page.
 */
export async function switchToWindowWithE2eBridge(handle, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        await browser.switchToWindow(handle);

        if (await browser.execute(() => Boolean(window.__TOUCHAI_E2E__))) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error('The search window did not become current after closing settings.');
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
