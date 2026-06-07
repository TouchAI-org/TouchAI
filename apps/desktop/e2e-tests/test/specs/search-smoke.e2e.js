import { waitForE2eBridge } from '../support/windows.js';

describe('TouchAI search smoke', () => {
    it('opens and closes quick-search results after typing into the search editor', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        const quickSearchPanel = await $("[data-testid='quick-search-panel']");

        await editor.waitForDisplayed();
        await waitForE2eBridge();
        await browser.execute((text) => {
            window.__TOUCHAI_E2E__.setSearchQuery(text);
        }, 'touchai');

        await quickSearchPanel.waitForDisplayed();
        const resultItem = await $("[data-testid='quick-search-result-item']");
        await resultItem.waitForDisplayed();

        const resultName = await resultItem.getAttribute('data-result-name');
        if (!resultName?.toLowerCase().includes('touchai')) {
            throw new Error(
                `Expected quick-search result to match "touchai", received "${resultName}"`
            );
        }

        const editorText = await editor.getText();
        if (!editorText.includes('touchai')) {
            throw new Error(`Expected editor text to contain "touchai", received "${editorText}"`);
        }

        const viewToggle = await $("[data-testid='quick-search-view-toggle']");
        await viewToggle.waitForDisplayed();
        await viewToggle.click();
        await $("[data-testid='quick-search-result-item']").waitForDisplayed();

        await browser.execute(() => {
            window.__TOUCHAI_E2E__.setSearchQuery('');
        });
        await quickSearchPanel.waitForDisplayed({ reverse: true });
    });
});
