describe('TouchAI search smoke', () => {
    it('opens the quick-search panel after typing into the search editor', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        const quickSearchPanel = await $("[data-testid='quick-search-panel']");

        await editor.waitForDisplayed();
        await browser.waitUntil(async () => {
            return browser.execute(() => Boolean(window.__TOUCHAI_E2E__));
        });
        await browser.execute((text) => {
            window.__TOUCHAI_E2E__.setSearchQuery(text);
        }, 'touchai');

        await quickSearchPanel.waitForDisplayed();
        const editorText = await editor.getText();
        if (!editorText.includes('touchai')) {
            throw new Error(`Expected editor text to contain "touchai", received "${editorText}"`);
        }
    });
});
