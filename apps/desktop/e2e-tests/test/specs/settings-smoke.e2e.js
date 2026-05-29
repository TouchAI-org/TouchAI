async function waitForE2EBridge() {
    await browser.waitUntil(async () => {
        return browser.execute(() => Boolean(window.__TOUCHAI_E2E__));
    });
}

async function openSettingsWindowFromMain(mainWindowHandle) {
    let settingsHandle = null;

    await waitForE2EBridge();

    await browser
        .executeAsync((done) => {
            window.__TOUCHAI_E2E__
                .openSettingsWindow()
                .then(() => done({ ok: true }))
                .catch((error) => done({ ok: false, error: String(error) }));
        })
        .then((result) => {
            if (!result?.ok) {
                throw new Error(
                    `Failed to open settings window: ${result?.error ?? 'unknown error'}`
                );
            }
        });

    await browser.waitUntil(async () => {
        const handles = await browser.getWindowHandles();
        for (const handle of handles) {
            if (handle === mainWindowHandle) {
                continue;
            }

            await browser.switchToWindow(handle);
            const currentUrl = await browser.getUrl();
            if (currentUrl.includes('/settings')) {
                settingsHandle = handle;
                return true;
            }
        }

        await browser.switchToWindow(mainWindowHandle);
        return false;
    });

    if (!settingsHandle) {
        throw new Error('Unable to locate settings window handle.');
    }

    await browser.switchToWindow(settingsHandle);
    return settingsHandle;
}

async function closeSettingsWindow(settingsHandle, mainWindowHandle) {
    await browser.switchToWindow(settingsHandle);
    const closeButton = await $("[data-testid='settings-window-close']");
    await closeButton.waitForDisplayed();
    await closeButton.click();

    await browser.waitUntil(async () => {
        const handles = await browser.getWindowHandles();
        return !handles.includes(settingsHandle);
    });

    await browser.switchToWindow(mainWindowHandle);
}

describe('TouchAI settings smoke', () => {
    it('opens settings, toggles the general switch, and creates a memory draft from the empty state', async () => {
        const mainWindowHandle = await browser.getWindowHandle();
        const settingsHandle = await openSettingsWindowFromMain(mainWindowHandle);

        const settingsView = await $("[data-testid='settings-view']");
        const generalSection = await $("[data-testid='settings-general-section']");
        const startMinimizedToggle = await $("[data-testid='settings-start-minimized-toggle']");

        await settingsView.waitForDisplayed();
        await generalSection.waitForDisplayed();

        const initialPressed = await startMinimizedToggle.getAttribute('aria-pressed');

        await startMinimizedToggle.click();
        await browser.waitUntil(async () => {
            return (await startMinimizedToggle.getAttribute('aria-pressed')) !== initialPressed;
        });

        await startMinimizedToggle.click();
        await browser.waitUntil(async () => {
            return (await startMinimizedToggle.getAttribute('aria-pressed')) === initialPressed;
        });

        const memoryNav = await $("[data-testid='settings-nav-memory']");
        await memoryNav.waitForDisplayed();

        const memoryNavTitle = await memoryNav.getAttribute('title');
        if (!memoryNavTitle || (!memoryNavTitle.includes('记忆') && !memoryNavTitle.includes('Memory'))) {
            throw new Error(
                `Expected memory nav title to include "记忆" or "Memory", received "${memoryNavTitle}"`
            );
        }
        if (memoryNavTitle.includes('长期记忆') || memoryNavTitle.includes('Long-term memory')) {
            throw new Error(`Unexpected legacy memory nav title: "${memoryNavTitle}"`);
        }

        await memoryNav.click();

        const emptyWorkspace = await $("[data-testid='settings-memory-empty-workspace']");
        await emptyWorkspace.waitForDisplayed();

        const emptyText = await emptyWorkspace.getText();
        if (!emptyText.includes('暂无记忆') && !emptyText.includes('No memories yet')) {
            throw new Error(`Expected empty memory title, received "${emptyText}"`);
        }
        if (
            emptyText.includes('长期记忆') ||
            emptyText.includes('Long-term memory') ||
            emptyText.includes('后续由 Agent') ||
            emptyText.includes('The agent will write reusable context')
        ) {
            throw new Error(`Unexpected legacy memory empty state rendered: "${emptyText}"`);
        }

        const panelExistsBeforeCreate = await $("[data-testid='settings-memory-panel']").isExisting();
        if (panelExistsBeforeCreate) {
            throw new Error('Memory side panel should not render before any memory exists.');
        }

        const createButton = await $("[data-testid='settings-memory-create']");
        await createButton.waitForDisplayed();
        await createButton.click();

        const memoryPanel = await $("[data-testid='settings-memory-panel']");
        const memoryContent = await $("[data-testid='settings-memory-content']");
        const titleInput = await $('input');

        await memoryPanel.waitForDisplayed();
        await memoryContent.waitForDisplayed();
        await titleInput.waitForDisplayed();

        const backgroundColor = await browser.execute(() => {
            const element = document.querySelector("[data-testid='settings-memory-content']");
            return element ? getComputedStyle(element).backgroundColor : null;
        });
        if (backgroundColor !== 'rgb(255, 255, 255)') {
            throw new Error(
                `Expected memory content background rgb(255, 255, 255), received "${backgroundColor}"`
            );
        }

        const createdTitle = await titleInput.getValue();
        if (!createdTitle || (createdTitle !== '新记忆' && createdTitle !== 'New memory')) {
            throw new Error(`Expected default memory title after create, received "${createdTitle}"`);
        }

        const memoryText = await memoryContent.getText();
        if (!memoryText.includes('已禁用') && !memoryText.includes('Disabled')) {
            throw new Error(`Expected new memory draft to start disabled, received "${memoryText}"`);
        }

        await closeSettingsWindow(settingsHandle, mainWindowHandle);
    });
});
