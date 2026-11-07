/**
 * User flow: launching TouchAI puts a usable search window in front of the user.
 */
import {
    assertVisible,
    expectSearchSurfaceSnapshot,
    useInterfaceLanguage,
    useProductFont,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

describe('user launches the desktop app', () => {
    before(async () => {
        await waitForE2eBridge();
        await useInterfaceLanguage();
        // The app ships no font in its bundle and downloads Source Han Serif on
        // first launch. Its `@font-face` points at the asset protocol, which the
        // shipped CSP blocks for `font-src` on Windows, so without this every
        // serif element renders in a generic face no user sees.
        await useProductFont();
    });

    it('user sees the search window with an editable prompt field', async () => {
        const searchView = await waitForTestIdDisplayed('search-view');
        const searchBar = await waitForTestIdDisplayed('search-bar');
        const editorHost = await waitForTestIdDisplayed('search-editor-host');

        assertVisible(await searchView.isDisplayed(), 'The search window was not visible.');
        assertVisible(await searchBar.isDisplayed(), 'The search bar was not visible.');

        const editor = await editorHost.$('.ProseMirror');
        await editor.waitForDisplayed();
        assertVisible(await editor.isDisplayed(), 'The prompt field was not visible.');

        // Window entrance and focus transitions settle before the first paint that
        // is meant to be compared. The search window is the app's first screen, so
        // a regression here is visible before any feature is used.
        //
        // Capture the visible card, independent of the transparent host envelope.
        await browser.pause(500);
        await expectSearchSurfaceSnapshot('search-window-empty');
    });

    it('user can focus the prompt field and type a query', async () => {
        const editorHost = await waitForTestIdDisplayed('search-editor-host');
        const editor = await editorHost.$('.ProseMirror');

        await editor.waitForDisplayed();
        await editor.click();
        await browser.keys(['t', 'o', 'u', 'c', 'h', 'a', 'i']);

        await browser.waitUntil(async () => (await editor.getText()).includes('touchai'), {
            timeoutMsg: 'The prompt field did not accept typed input.',
        });
    });
});
