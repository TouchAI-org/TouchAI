/**
 * User flows for quick search: typing shows file matches, and the panel closes
 * again when nothing matches, without leaving the search window unusable.
 *
 * The query is a fixture the E2E bridge answers for, rather than a phrase that
 * happens to match files on the machine running the test. Real indexing depends on
 * what is on disk, so a phrase like "touchai" finds nothing on a fresh CI runner
 * and dozens of entries on a developer's laptop — the flow would pass or fail for
 * reasons that have nothing to do with the code.
 */
import {
    assertVisible,
    findElementByTestId,
    waitForE2eBridge,
    waitForTestIdDisplayed,
    waitForTestIdNotDisplayed,
} from '../support/desktop.js';

const MATCHING_QUERY = 'touchai-visual-fixture';

async function typeQuery(query) {
    await waitForE2eBridge();
    await browser.execute((text) => {
        window.__TOUCHAI_E2E__.setSearchQuery(text);
    }, query);
}

describe('user searches for a local file', () => {
    it('user sees a results panel when the query matches an indexed file', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        await editor.waitForDisplayed();

        await typeQuery(MATCHING_QUERY);

        const quickSearchPanel = await waitForTestIdDisplayed('quick-search-panel');
        assertVisible(await quickSearchPanel.isDisplayed(), 'The results panel was not visible.');

        await browser.waitUntil(async () => (await editor.getText()).includes(MATCHING_QUERY), {
            timeoutMsg: 'The prompt field did not reflect the typed query.',
        });
    });

    it('user sees the results panel close when the query matches nothing', async () => {
        await waitForTestIdDisplayed('quick-search-panel');

        await typeQuery('zzzz-no-such-file-zzzz');

        await waitForTestIdNotDisplayed('quick-search-panel');
    });

    it('user keeps a usable search window after clearing the query', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");

        await typeQuery(MATCHING_QUERY);
        await waitForTestIdDisplayed('quick-search-panel');

        await typeQuery('');
        await waitForTestIdNotDisplayed('quick-search-panel');

        const searchView = await findElementByTestId('search-view');
        assertVisible(
            await searchView.isDisplayed(),
            'The search window disappeared after clearing the query.'
        );
        assertVisible(await editor.isDisplayed(), 'The prompt field was no longer visible.');
    });
});
