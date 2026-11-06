/**
 * User flow: launching TouchAI puts a usable search window in front of the user.
 */
import {
    assertVisible,
    useInterfaceLanguage,
    useProductFont,
    visualMismatchTolerance,
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
        // The baseline is the native window (798x108): a 750x60 search surface plus
        // the transparent shadow gutter. A machine that renders at 150% DPI captures
        // a larger image, which the comparison resizes back down;
        // `visualMismatchTolerance()` widens the budget for exactly that case.
        await browser.pause(500);
        await expect(browser).toMatchScreenSnapshot(
            'search-window-empty',
            await visualMismatchTolerance()
        );
    });

    it('user sees the search window as a rounded floating surface with a shadow', async () => {
        const styles = await browser.execute(() => {
            const shell = document.querySelector('[data-testid="search-window-shell"]');
            const view = document.querySelector('[data-testid="search-view"]');
            const shellStyle = getComputedStyle(shell);
            const frameStyle = getComputedStyle(shell.parentElement);
            return {
                radius: shellStyle.borderRadius,
                shadow: shellStyle.boxShadow,
                padding: frameStyle.paddingTop,
                backdropFilter: getComputedStyle(view).backdropFilter,
            };
        });

        assertVisible(
            styles.radius !== '0px',
            `The search window lost its rounded shell: ${styles.radius}.`
        );
        assertVisible(
            styles.shadow !== 'none' && !styles.shadow.includes('rgba(0, 0, 0, 0) 0px 0px'),
            `The search window lost its drop shadow: ${styles.shadow}.`
        );
        assertVisible(
            styles.padding === '24px',
            `The search window has no room for its shadow: ${styles.padding}.`
        );
        assertVisible(
            styles.backdropFilter === 'none',
            `The search window still paints an opaque backdrop layer: ${styles.backdropFilter}.`
        );
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
