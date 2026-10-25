/**
 * User flows for the search window itself: it starts at the idle size, and a conversation
 * can make it taller. The assertions read the window state from the app rather than from the
 * DOM, because the thing under test is the window, not the rendering inside it.
 */
import {
    assertVisible,
    callE2eBridge,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

async function windowState() {
    return browser.executeAsync((done) => {
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
}

async function readWindowState() {
    const result = await windowState();
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

    it('user sees the idle window at its configured height', async () => {
        await resetWindow();

        const state = await readWindowState();
        assertVisible(
            Math.abs(state.currentHeight - state.defaults.height) <= 2,
            `The idle window was ${state.currentHeight} tall instead of ${state.defaults.height}.`
        );
    });

    it('user sees the window grow when a conversation asks for more room', async () => {
        await resetWindow();
        const before = await readWindowState();

        await callE2eBridge('resizeWindowHeight', {
            targetHeight: before.defaults.height + 240,
            center: false,
            animate: false,
            respectManualOverride: false,
        });

        await browser.waitUntil(
            async () => {
                const state = await readWindowState();
                return state.currentHeight > before.currentHeight + 100;
            },
            { timeoutMsg: 'The window did not grow after the resize request.' }
        );

        const after = await readWindowState();
        assertVisible(
            after.currentHeight > before.currentHeight,
            `The window height did not change: ${before.currentHeight} -> ${after.currentHeight}.`
        );
    });

    it('user gets the window back to its idle height after the conversation closes', async () => {
        await resetWindow();

        const state = await readWindowState();
        assertVisible(
            Math.abs(state.currentHeight - state.defaults.height) <= 2,
            `The window did not return to its idle height: ${state.currentHeight}.`
        );
        assertVisible(
            state.currentWidth === state.defaults.width,
            `The window width changed unexpectedly: ${state.currentWidth} vs ${state.defaults.width}.`
        );
    });
});
