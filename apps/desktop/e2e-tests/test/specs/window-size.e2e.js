/**
 * User flows for the search window itself. The assertions read the window state from the app
 * rather than from the DOM, because the subject is the native window, not the rendering
 * inside it.
 *
 * These flows drive the window commands directly. Starting a real conversation needs a model,
 * so the "conversation makes the window taller" case is covered by the unit tests in
 * apps/desktop/tests/composables/SearchView/useSearchWindowResize.test.ts; what only an E2E can
 * prove is that the native commands move the real window.
 */
import {
    assertVisible,
    callE2eBridge,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

async function readWindowState() {
    const result = await browser.executeAsync((done) => {
        const bridge = window.__TOUCHAI_E2E__;
        if (!bridge || typeof bridge.getSearchWindowState !== 'function') {
            done({ ok: false, error: 'getSearchWindowState is not available' });
            return;
        }
        bridge
            .getSearchWindowState()
            .then((state) => done({ ok: true, state }))
            .catch((error) => done({ ok: false, error: String(error) }));
    });

    assertVisible(result.ok, `Reading the window state failed: ${result.error}`);
    return result.state;
}

async function resetWindow() {
    await callE2eBridge('resetSearchWindowBounds');
    await browser.waitUntil(
        async () => {
            const state = await readWindowState();
            return Math.abs(state.currentHeight - state.defaults.height) <= 2;
        },
        { timeoutMsg: 'The window did not return to its idle height.' }
    );
}

describe('user works with the search window size', () => {
    before(async () => {
        await waitForE2eBridge();
        await waitForTestIdDisplayed('search-view');
    });

    after(async () => {
        // Leave the window at its idle size so later specs start from a known state.
        await callE2eBridge('resetSearchWindowBounds');
    });

    it('user sees the idle window at its configured width and height before any conversation opens', async () => {
        await resetWindow();

        const state = await readWindowState();
        assertVisible(
            Math.abs(state.currentHeight - state.defaults.height) <= 2,
            `The idle window was ${state.currentHeight} tall instead of ${state.defaults.height}.`
        );
        assertVisible(
            state.currentWidth === state.defaults.width,
            `The idle window was ${state.currentWidth} wide instead of ${state.defaults.width}.`
        );
    });

    it('user sees the window grow when the page asks for a taller one', async () => {
        await resetWindow();
        const before = await readWindowState();
        const target = before.defaults.height + 240;

        await callE2eBridge('resizeWindowHeight', {
            targetHeight: target,
            center: false,
            animate: false,
            respectManualOverride: false,
        });

        await browser.waitUntil(
            async () => {
                const state = await readWindowState();
                return state.currentHeight > before.currentHeight + 100;
            },
            { timeoutMsg: `The window did not grow after asking for ${target}px.` }
        );

        const after = await readWindowState();
        assertVisible(
            after.currentHeight > before.currentHeight,
            `The window height did not change: ${before.currentHeight} -> ${after.currentHeight}.`
        );
    });

    it('user gets the window back to its idle size after the page resets a grown window', async () => {
        await resetWindow();
        const initial = await readWindowState();

        // Grow it first, so the reset below is proven to undo a real change.
        await callE2eBridge('resizeWindowHeight', {
            targetHeight: initial.defaults.height + 240,
            center: false,
            animate: false,
            respectManualOverride: false,
        });
        await browser.waitUntil(
            async () => (await readWindowState()).currentHeight > initial.currentHeight + 100,
            { timeoutMsg: 'The window did not grow, so the reset below would prove nothing.' }
        );

        await callE2eBridge('resetSearchWindowBounds');

        await browser.waitUntil(
            async () => {
                const state = await readWindowState();
                return (
                    Math.abs(state.currentHeight - state.defaults.height) <= 2 &&
                    state.currentWidth === state.defaults.width
                );
            },
            { timeoutMsg: 'The window did not return to its idle size after the reset.' }
        );
    });
});
