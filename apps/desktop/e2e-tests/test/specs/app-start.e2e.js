describe('TouchAI desktop startup', () => {
    it('shows the main search window and its editor host in E2E mode', async () => {
        const searchView = await $("[data-testid='search-view']");
        const searchBar = await $("[data-testid='search-bar']");
        const editorHost = await $("[data-testid='search-editor-host']");

        await searchView.waitForDisplayed();
        await searchBar.waitForDisplayed();
        await editorHost.waitForDisplayed();
    });
});
