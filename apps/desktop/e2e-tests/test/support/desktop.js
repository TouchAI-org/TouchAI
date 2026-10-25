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
 * Fails unless the interface is really painted in the product typeface.
 *
 * Every cheap version of this check gives a false pass, which is why it is written
 * the long way round:
 *
 *   - `document.fonts.check("16px 'TouchAI Source Han Serif SC'")` returns `true`
 *     even for a family that exists nowhere. Measured in the app:
 *     `document.fonts.check("16px 'NoSuchFamilyXYZ123'")` -> `true`.
 *   - `FontFace.status` reaches `"loaded"` whenever the bytes download and parse, even
 *     if the engine then declines to paint them.
 *   - Latin metrics coincide: the product face at weight 400 and the fallback both
 *     measured 281.68px wide with 469 ink pixels for the same string.
 *
 * The defect this guards against was exactly that kind of silent fallback. The
 * `@font-face` rule omitted `format('woff2 supports variations')`, so the engine
 * treated the variable font as static, found no instance for the requested weight,
 * and painted whatever `serif` resolved to. Nothing failed; the window just used a
 * different typeface than the one the app ships.
 *
 * Han glyphs are the discriminator, because Chinese is set in fixed-width squares
 * (advance width says nothing) while the strokes differ plainly between faces.
 *
 * The comparison is against a second face built from the app's own bytes rather than
 * against the generic `serif`. Two reasons, both learned the hard way:
 *
 *   - `serif` is machine-dependent. On a developer box it resolves to an installed CJK
 *     serif, so a fallback is detectable; on a bare CI runner it has no Han glyphs at
 *     all, so the product family and `serif` both rasterise as the same tofu boxes and
 *     the check reports a false failure.
 *   - `new FontFace(bytes, { weight: '250 900' })` falls back in this engine exactly
 *     like the defective CSS rule did, which made the reference itself the broken
 *     side of the comparison. The reference therefore has to be declared the same way
 *     the app declares it: an `@font-face` rule with the variations format hint.
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

                // Declare the reference the same way the app declares its face. Anything
                // weaker (the FontFace constructor with a weight range) falls back, which
                // would compare a broken reference against a correct product face.
                const referenceRule = document.createElement('style');
                referenceRule.textContent = `
                    @font-face {
                        font-family: '${refFamily}';
                        src: url('${fontUrl}') format('woff2 supports variations');
                        font-weight: 250 900;
                        font-display: block;
                    }
                `;
                document.head.appendChild(referenceRule);
                await document.fonts.load(`52px '${refFamily}'`);
                await document.fonts.ready;

                const product = rasterise(`'${productFamily}'`);
                const reference = rasterise(`'${refFamily}'`);
                const serif = rasterise('serif');

                return {
                    usesDataUrl: (injected ?? '').includes('data:font'),
                    againstReference: differingPixels(product, reference),
                    againstSerif: differingPixels(product, serif),
                    // Sanity: on a machine with CJK fonts the two differ; on a bare
                    // runner both are tofu, which is fine — the reference comparison
                    // does not depend on it.
                    referenceAgainstSerif: differingPixels(reference, serif),
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

    // The painted face must match the app's own bytes. Anti-aliasing leaves a small
    // residual; a fallback differs by thousands of pixels.
    if (report.againstReference > 500) {
        throw new Error(
            `The interface is painting a fallback face instead of "${family}" ` +
                `(${report.againstReference} pixels differ from a reference face built ` +
                `from the same file). Declared format: ${report.declaredFormat}, ` +
                `declared weight: ${report.declaredWeight}. ` +
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
