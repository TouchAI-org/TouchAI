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
 * Waits until the app has loaded its own interface font.
 *
 * The app ships no font: `src/utils/font.ts` downloads Source Han Serif into
 * `<app root>/assets/font/` and injects `@font-face` pointing at the Tauri asset
 * protocol. `wdio.conf.js` provisions the file for each session, and this waits for
 * the app to load it through its real code path.
 *
 * It deliberately does not substitute a `data:` source. An earlier version did, to
 * work around a CSP that blocked the asset URL, which meant the suite proved nothing
 * about the path users actually take. That CSP is fixed and pinned by
 * `tests/ci/tauri-csp-font.test.ts`, so the app loads the font itself here.
 */
export async function useProductFont() {
    const family = 'TouchAI Source Han Serif SC';

    const report = await browser.executeAsync((done) => {
        const probe = "16px 'TouchAI Source Han Serif SC'";

        (async () => {
            await document.fonts.load(probe);
            await document.fonts.ready;

            const injected = document.querySelector('style[data-touchai-font-face]')?.textContent;

            return {
                available: document.fonts.check(probe),
                usesDataUrl: (injected ?? '').includes('data:font'),
            };
        })()
            .then((result) => done(result))
            .catch((error) => done({ error: String(error) }));
    });

    if (report?.usesDataUrl) {
        throw new Error(
            "A data: font source was injected by the test, so the app's own asset-protocol loading path was not exercised."
        );
    }

    if (!report?.available) {
        throw new Error(
            `The product font "${family}" did not load (${report?.error ?? 'no further detail'}), so screenshots would show a fallback face instead of the interface a user sees.`
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
