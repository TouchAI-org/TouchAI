/**
 * User flow: launching TouchAI puts a usable search window in front of the user.
 */
import { assertVisible, waitForTestIdDisplayed } from '../support/desktop.js';

describe('user launches the desktop app', () => {
    it('user sees the search window with an editable prompt field', async () => {
        const searchView = await waitForTestIdDisplayed('search-view');
        const searchBar = await waitForTestIdDisplayed('search-bar');
        const editorHost = await waitForTestIdDisplayed('search-editor-host');

        assertVisible(await searchView.isDisplayed(), 'The search window was not visible.');
        assertVisible(await searchBar.isDisplayed(), 'The search bar was not visible.');

        const editor = await editorHost.$('.ProseMirror');
        await editor.waitForDisplayed();
        assertVisible(await editor.isDisplayed(), 'The prompt field was not visible.');
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
